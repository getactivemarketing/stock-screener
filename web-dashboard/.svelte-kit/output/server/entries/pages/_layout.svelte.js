import { w as slot } from "../../chunks/index.js";
function _layout($$renderer, $$props) {
  $$renderer.push(`<header><div class="container"><h1><a href="/">Stock Screener</a></h1> <p>Value + Momentum Scanner</p></div></header> <main class="container"><!--[-->`);
  slot($$renderer, $$props, "default", {});
  $$renderer.push(`<!--]--></main>`);
}
export {
  _layout as default
};
