'use strict';

// A small Itanium ABI demangler, for the case where no c++filt is around --
// which is every plain Windows machine, and this extension is used on Windows
// while the maps it reads come off a Linux build.
//
// It deliberately understands only the shapes that are worth reading: namespaced
// functions, member functions, constructors and destructors, operators, builtin
// parameter types, pointers and references, and back-references. Templates, ABI
// tags, function and array types and anything else make it give up and return
// null, so the caller keeps the mangled name.
//
// That trade is on purpose. In the checked-in maps 489 of the 503 mangled
// symbols are libc++ internals whose demangled form is a 200-character template
// nobody reads; the fourteen that matter are all in the subset below. Guessing
// at the rest would risk printing a name that is quietly wrong, which is worse
// than printing the mangled one.

const BUILTIN = {
  v: 'void', w: 'wchar_t', b: 'bool', c: 'char', a: 'signed char', h: 'unsigned char',
  s: 'short', t: 'unsigned short', i: 'int', j: 'unsigned int', l: 'long',
  m: 'unsigned long', x: 'long long', y: 'unsigned long long', n: '__int128',
  o: 'unsigned __int128', f: 'float', d: 'double', e: 'long double', z: '...'
};

// Only the operators that turn up in real object code. Anything else bails.
const OPERATOR = {
  nw: ' new', na: ' new[]', dl: ' delete', da: ' delete[]',
  ps: '+', ng: '-', ad: '&', de: '*', co: '~',
  pl: '+', mi: '-', ml: '*', dv: '/', rm: '%', an: '&', or: '|', eo: '^',
  aS: '=', pL: '+=', mI: '-=', mL: '*=', dV: '/=', rM: '%=',
  aN: '&=', oR: '|=', eO: '^=', ls: '<<', rs: '>>', lS: '<<=', rS: '>>=',
  eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=',
  nt: '!', aa: '&&', oo: '||', pp: '++', mm: '--', cm: ',',
  ix: '[]', cl: '()', pt: '->', pm: '->*'
};

const SPECIAL = { TV: 'vtable for ', TT: 'VTT for ', TI: 'typeinfo for ', TS: 'typeinfo name for ' };

class Bail extends Error {}

// type() recurses once per pointer, reference or qualifier, so a symbol carrying
// a few thousand of them would overflow the stack and throw out of a function
// whose whole contract is to return null instead. Real signatures never come
// close to this.
const MAX_TYPE_DEPTH = 64;

class Reader {
  constructor(text) {
    this.text = text;
    this.pos = 0;
    this.subs = [];
    this.depth = 0;
  }

  peek(count) { return this.text.substr(this.pos, count || 1); }
  eof() { return this.pos >= this.text.length; }
  take(count) { const out = this.peek(count); this.pos += out.length; return out; }
  expect(ch) { if (this.take(1) !== ch) throw new Bail(); }
  give(text) { this.subs.push(text); return text; }

  // <source-name> ::= <number> <identifier>
  sourceName() {
    let digits = '';
    while (/[0-9]/.test(this.peek())) digits += this.take(1);
    if (!digits) throw new Bail();
    const length = parseInt(digits, 10);
    if (!length || this.pos + length > this.text.length) throw new Bail();
    return this.take(length);
  }

  // S_ is the first back-reference, S0_ the second, S1_ the third.
  substitution() {
    this.expect('S');
    if (this.peek() === '_') { this.take(1); return this.at(0); }
    let id = '';
    while (/[0-9A-Z]/.test(this.peek()) && this.peek() !== '_') id += this.take(1);
    this.expect('_');
    if (!/^[0-9]+$/.test(id)) throw new Bail(); // St, Sa and friends are not in scope
    return this.at(parseInt(id, 10) + 1);
  }

  at(index) {
    if (index < 0 || index >= this.subs.length) throw new Bail();
    return this.subs[index];
  }

  // One component of a nested name. Constructors and destructors need the class
  // name that came before them, so it is passed in.
  component(enclosing) {
    const head = this.peek(2);
    if (head === 'C1' || head === 'C2' || head === 'C3') {
      this.take(2);
      if (!enclosing) throw new Bail();
      return enclosing;
    }
    if (head === 'D0' || head === 'D1' || head === 'D2') {
      this.take(2);
      if (!enclosing) throw new Bail();
      return '~' + enclosing;
    }
    if (Object.prototype.hasOwnProperty.call(OPERATOR, head)) {
      this.take(2);
      return 'operator' + OPERATOR[head];
    }
    if (this.peek() === 'L') this.take(1); // internal linkage
    if (/[0-9]/.test(this.peek())) return this.sourceName();
    throw new Bail();
  }

  // <nested-name> ::= N [<CV-qualifiers>] <component>+ E
  nestedName() {
    this.expect('N');
    let trailer = '';
    for (;;) {
      const ch = this.peek();
      if (ch === 'K') { trailer = ' const' + trailer; this.take(1); }
      else if (ch === 'V') { trailer = ' volatile' + trailer; this.take(1); }
      else if (ch === 'r') { this.take(1); }
      else break;
    }

    const parts = [];
    while (this.peek() !== 'E') {
      if (this.eof()) throw new Bail();
      // Every completed prefix can be referred to later, so record it before
      // reading the component that follows it.
      if (parts.length) this.give(parts.join('::'));
      parts.push(this.component(parts.length ? parts[parts.length - 1] : null));
    }
    this.expect('E');
    if (!parts.length) throw new Bail();
    return { name: parts.join('::'), trailer: trailer };
  }

  // <type>, restricted to the forms that show up in ordinary signatures.
  type() {
    if (++this.depth > MAX_TYPE_DEPTH) throw new Bail();
    try {
      return this.typeInner();
    } finally {
      this.depth--;
    }
  }

  typeInner() {
    const ch = this.peek();

    if (ch === 'P') { this.take(1); return this.give(this.type() + '*'); }
    if (ch === 'R') { this.take(1); return this.give(this.type() + '&'); }
    if (ch === 'O') { this.take(1); return this.give(this.type() + '&&'); }
    if (ch === 'K') { this.take(1); return this.give(this.type() + ' const'); }
    if (ch === 'V') { this.take(1); return this.give(this.type() + ' volatile'); }
    if (ch === 'r') { this.take(1); return this.type(); }

    if (ch === 'S') {
      if (this.peek(2) === 'St') { this.take(2); return this.give('std::' + this.sourceName()); }
      return this.substitution();
    }
    if (ch === 'N') return this.give(this.nestedName().name);
    if (/[0-9]/.test(ch)) return this.give(this.sourceName());

    if (Object.prototype.hasOwnProperty.call(BUILTIN, ch)) {
      this.take(1);
      return BUILTIN[ch]; // builtins are never substitution candidates
    }
    throw new Bail(); // I, B, F, A, M, T, U, D... - not our business
  }

  parameters() {
    const types = [];
    while (!this.eof()) types.push(this.type());
    if (types.length === 1 && types[0] === 'void') return '()';
    return '(' + types.join(', ') + ')';
  }
}

/**
 * @param {string} mangled a symbol as it appears in the map file
 * @returns {string|null} the demangled name, or null if it is not understood
 */
function demangleName(mangled) {
  if (typeof mangled !== 'string') return null;
  // Mach-O puts an underscore in front of every symbol.
  const text = /^__Z/.test(mangled) ? mangled.slice(1) : mangled;
  if (!/^_Z/.test(text)) return null;

  const reader = new Reader(text.slice(2));
  try {
    const special = SPECIAL[reader.peek(2)];
    if (special) {
      reader.take(2);
      const name = reader.peek() === 'N' ? reader.nestedName().name : reader.type();
      if (!reader.eof()) throw new Bail();
      return special + name;
    }

    let name;
    let trailer = '';
    if (reader.peek() === 'N') {
      const nested = reader.nestedName();
      name = nested.name;
      trailer = nested.trailer;
    } else if (Object.prototype.hasOwnProperty.call(OPERATOR, reader.peek(2))) {
      name = 'operator' + OPERATOR[reader.take(2)];
    } else {
      name = reader.sourceName();
    }

    // Nothing left means a variable rather than a function.
    const suffix = reader.eof() ? '' : reader.parameters();
    return name + suffix + trailer;
  } catch (e) {
    if (e instanceof Bail) return null;
    throw e;
  }
}

module.exports = { demangleName };
