import { MOBILE_HTML } from "../src/main/remoteControl/mobilePage.ts";

const script = MOBILE_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];

if (!script) {
  throw new Error("mobile page inline script is missing");
}

new Function(script);
console.log("mobilePage inline script syntax: OK");
