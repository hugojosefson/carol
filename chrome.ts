/**
 * Substantial parts adapted from https://github.com/zserge/lorca/blob/a3e43396a47ea152501d3453514c7f373cea530a/chrome.go
 * which is licensed as follows:
 *
 * MIT License
 *
 * Copyright (c) 2018 Serge Zaitsev
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { Transport, createWSTransport, IncommingMessage } from "./transport.ts";
import {
  assert,
  BufReader,
  decode,
  deferred,
  Deferred,
  sprintf
} from "./deps.ts";

interface Chrome {
  // TODO add support for passing a JS function
  evaluate(expr: string): Promise<any>;
  exit(): void;
}

interface Logger {
  log(message: any): void;
  error(message: any): void;
}

type Binding = (args: any[]) => any;

export class EvaluateError extends Error {}

class ChromeImpl implements Chrome {
  #process: Deno.Process;
  #transport: Transport;
  #logger: Logger;

  #pending: Map<number, Deferred<any>> = new Map();
  #bindings: Map<string, Binding> = new Map();

  #target!: string;
  #session!: string;
  #window!: number;

  constructor(
    process: Deno.Process,
    transport: Transport,
    logger: Logger = console) {
    this.#process = process;
    this.#transport = transport;
    this.#logger = logger;
  }

  async startSession(targetId: string): Promise<void> {
    this.#target = targetId;
    const id = 1;
    this.sendMessage(id, "Target.attachToTarget", {
      id,
      params: { targetId }
  	});

    while (true) {
      const message = await this.#transport.receive();
      if (hasId(message, id)) {
        if (hasError(message)) {
          throw new Error(`Target error: ${message.error}`);
        }
        // FIXME
        if ((message as any).result && (message as any).result.sessionId) {
          this.#session = (message as any).result.sessionId;
          return;
        }
      }
    }
  }

  async findTarget(): Promise<string> {
    this.sendMessage(0, "Target.setDiscoverTargets", {
      params: {discover: true}
    });

    while (true) {
      const message = await this.#transport.receive();
      if (isTargetCreated(message) && message.params.targetInfo.type === "page") {
        return message.params.targetInfo.targetId;
      }
    }
  }

  evaluate(expr: string): Promise<any> {
    return this.sendMessageToTarget("Runtime.evaluate", {
      "expression": expr,
      "awaitPromise": true,
      "returnByValue": true
    });
  }

  exit() {
    this.#process.stderr!.close();
    this.#transport.close();
    this.#process.close();
  }

  #lastId = 0;
  private nextId(): number {
    return ++this.#lastId;
  }

  sendMessageToTarget(method: string, args: object = {}) {
    assert(this.#session, "session must be created");
    const id = this.nextId();
    return this.sendMessage(id, "Target.sendMessageToTarget", {
      "params": {
        "message": JSON.stringify({
          "id": id,
          "method": method,
          "params": args,
        }),
        "sessionId": this.#session
      },
    });
  }

  private sendMessage(id: number, method: string, args: object = {}): Promise<object> {
    const message = {
      id,
      method,
      ...args
    };
    this.#transport.send(message);
    const promise = deferred<object>();
    this.#pending.set(id, promise);
    return promise;
  }

  async getWindowForTarget(target: string): Promise<{
    windowId: number;
    bounds: object;
  }> {
    const msg = await this.sendMessageToTarget("Browser.getWindowForTarget", {"targetId": target});
    return msg as any; // FIXME
  }

  setWindow(windowId: number): void {
    this.#window = windowId;
  }

  async readLoop(): Promise<void> {
	  while (!this.#transport.isClosed()) {
      let m!: IncommingMessage;
      try {
          m = await this.#transport.receive();
      } catch (err) {
        this.#logger.error(err);
        if (this.#transport.isClosed()) {
          break;
        }
      }

	  	if (m.method == "Target.receivedMessageFromTarget") {
        type TargetReceivedMessageFromTargetParams = {
          sessionId: string;
          message: string;
        };

        type TargetReceivedMessageFromTargetMessage = {
          id: number;
          method: string;
          params: object;
          error?: { message?: string };
          result: {
            result?: {
              description: string;
              type: string;
              subtype: string;
              value: object;
            },
            exceptionDetails?: {
              exception?: { value?: string }
            }
          }
        };

        const params = m.params as TargetReceivedMessageFromTargetParams;

	  		if (params.sessionId != this.#session) {
	  			continue
        }

	  		const res = JSON.parse(params.message) as TargetReceivedMessageFromTargetMessage;
	  		if (res.id == 0 && res.method == "Runtime.consoleAPICalled" || res.method == "Runtime.exceptionThrown") {
	  			this.#logger.log(params.message)
	  		} else if (res.id == 0 && res.method == "Runtime.bindingCalled") {
          type RuntimeBindingCalledParams = {
            id: number;
            name: string;
            payload: {
              name: string;
              seq: number;
              args: object[]
            }
          };
          const { payload, name: bindingName, id: contextId } = (res.params as RuntimeBindingCalledParams);
	  			const binding = this.#bindings.get(bindingName);
	  			if (binding) {
	  				(async () => {
              let result: string = "";
              let error: string = "";
              try {
                const r = await binding!(payload.args);
                result = JSON.stringify(r);
              } catch(err) {
                error = err.message;
              }
	  					const expr = sprintf(`
	  						if (%[4]s) {
	  							window['%[1]s']['errors'].get(%[2]d)(%[4]s);
	  						} else {
	  							window['%[1]s']['callbacks'].get(%[2]d)(%[3]s);
	  						}
	  						window['%[1]s']['callbacks'].delete(%[2]d);
	  						window['%[1]s']['errors'].delete(%[2]d);
                `, payload.name, payload.seq, result, error);

	  					this.sendMessageToTarget("Runtime.evaluate", {
                "expression": expr,
                "contextId": contextId
              });
	  				})();
	  			}
	  			continue;
	  		}

        const resc = this.#pending.get(res.id);
	  		this.#pending.delete(res.id);

	  		if (!resc) {
	  			continue;
        }

	  		if (res.error?.message) {
          resc.reject(new EvaluateError(res.error!.message));
	  		} else if (res.result.exceptionDetails?.exception?.value != null) {
          resc.reject(new EvaluateError(JSON.stringify(res.result.exceptionDetails.exception.value)));
	  		} else if (res.result.result?.type == "object" && res.result.result.subtype == "error") {
          resc.reject(new EvaluateError(res.result.result.description));
	  		} else if (res.result.result?.type) {
          resc.resolve(JSON.stringify(res.result.result.value));
	  		} else {
          const message = JSON.parse(params.message) as TargetReceivedMessageFromTargetMessage;
          resc.resolve(message.result);
	  		}
	  	} else if (m.method == "Target.targetDestroyed") {
        type TargetDestroyedParams = {
          targetId: string
        };
        const params = m.params as TargetDestroyedParams;
	  		if (params.targetId == this.#target) {
	  			this.exit();
	  			return;
	  		}
	  	}
	  }
  }
}

function hasId(x: object, id: number): x is { id: number } {
  return x && (x as any).id === id;
}

function hasError(x: object): x is { error: any } {
  return x && (x as any).error != null;
}

function isTargetCreated(x: object): x is {
  method: "Target.targetCreated";
  params: {
    targetInfo: {
      type: string;
      targetId: string;
    }
  }
} {
  return x && (x as any)["method"] === "Target.targetCreated";
}

export interface RunChromeOptions {
  executable: string;
  args: string[];
}

export async function runChrome(options: RunChromeOptions): Promise<Chrome> {
  const process = Deno.run({
    cmd: [options.executable, ...options.args],
    stderr: "piped"
  });
  const wsEndpoint = await waitForWSEndpoint(process.stderr!);
  const transport = await createWSTransport(wsEndpoint);
  return createChrome({
    process,
    transport,
    headless: options.args.includes("--headless")
  });
}

export interface CreateChromeOptions {
  process: Deno.Process;
  transport: Transport;
  headless: boolean;
}

export async function createChrome({
  process,
  transport,
  headless
}: CreateChromeOptions): Promise<Chrome> {
  const chrome = new ChromeImpl(process, transport);
  try {
    const targetId = await chrome.findTarget();
    await chrome.startSession(targetId);
    chrome.readLoop();
	  for (const [method, params] of [
      ["Page.enable"],
	  	["Target.setAutoAttach", { "autoAttach": true, "waitForDebuggerOnStart": false }],
	  	["Network.enable"],
	  	["Runtime.enable"],
	  	["Security.enable"],
	  	["Performance.enable"],
	  	["Log.enable"]
    ] as Array<[string, object | undefined]>) {
      try {
        chrome.sendMessageToTarget(method, params);
      } catch (error) {
        chrome.exit();
        // chrome.process.wait();
        throw error;
      }
    }

    if (!headless) {
      try {
        const window = await chrome.getWindowForTarget(targetId);
        chrome.setWindow(window.windowId);
      } catch (err) {
        chrome.exit();
        throw err;
      }
    }

    return chrome;
  } catch (err) {
    chrome.exit();
    throw err;
  }
}

async function waitForWSEndpoint(r: Deno.Reader): Promise<string> {
  const b = BufReader.create(r);
  // TODO handle timeout
  while (true) {
    const result = await b.readLine();
    if (result === null) {
      throw new Error("EOF");
    }
    const line = decode(result.line);
    const match = line.match(/^DevTools listening on (ws:\/\/.*?)\r?$/);
    if (match) {
      return match[1];
    }
  }
}
