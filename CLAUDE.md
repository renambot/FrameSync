# FrameSync

**Browser support:** Chromium-first. Wall nodes are Chrome kiosks, and WebGPU
and the Window Management API are Chromium-only. Baseline Newly Available
features (popover, anchor positioning, `:has()`, interest invokers) may be used
when feature-detected and degrading cleanly; Safari and Firefox get the
fallback, never a broken page.

**Zero dependencies:** no npm, no build step, no polyfills. MP4Box.js is
vendored in `js/mp4box/`; everything else is hand-written. Do not add a
package without asking.
