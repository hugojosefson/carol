import { launch } from "../mod.ts";
import {
  dirname,
  fromFileUrl,
  join,
} from "https://deno.land/std@0.109.0/path/mod.ts";

const app = await launch({
  title: "Hello Deno!",
  width: 480,
  height: 320,
});

app.onExit().then(() => Deno.exit(0));

await app.exposeFunction("greet", (name: string) => `Hello, ${name}!`);
const folder = join(dirname(fromFileUrl(import.meta.url)), "public");
app.serveFolder(folder); // Serve contents from "./public" folder
await app.load("index.html");
