/**
 * DOM polyfills for pdfjs-dist in server environments.
 * Required when @napi-rs/canvas is not available (e.g., Azure App Service).
 * Must be imported BEFORE pdfjs-dist.
 */
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
    }
  }
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D { }
}
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
  }
}
