// A DOM small enough to read, big enough to prove the escaping rule.
//
// jsdom would work, but it is a dependency, and the property under test here is
// narrow: does the rendering code put untrusted strings in as *text*? A stub
// answers that better than a real DOM would, because it cannot parse HTML at
// all - so if a test finds an element that the code did not explicitly create,
// something built it from a string, which is exactly the bug being hunted.

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this._text = "";
  }

  set textContent(value) {
    // Text, never markup. The stub stores the string verbatim and creates no
    // children from it - the same observable behaviour as the real thing.
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    if (this.children.length) {
      return this._text + this.children.map((child) => child.textContent).join("");
    }
    return this._text;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
    this._text = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener() {}

  /** Depth-first walk, for assertions. */
  *walk() {
    yield this;
    for (const child of this.children) {
      yield* child.walk();
    }
  }

  /** Every element tag present in this subtree. */
  tags() {
    return [...this.walk()].map((node) => node.tagName);
  }

  /** All text in this subtree, concatenated. */
  allText() {
    return [...this.walk()].map((node) => node._text).join("");
  }
}

class StubText extends StubNode {
  constructor(value) {
    super("#text");
    this._text = String(value);
  }
}

export function createStubDocument() {
  const byId = new Map();
  const body = new StubNode("body");
  return {
    body,
    createElement: (tag) => new StubNode(tag),
    createTextNode: (value) => new StubText(value),
    getElementById: (id) => byId.get(id) ?? null,
    _register(id, node) {
      byId.set(id, node);
      return node;
    },
  };
}

export { StubNode };
