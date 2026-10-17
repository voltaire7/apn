// Word motions as fish's line editor makes them (fish src/reader/word_motion.rs),
// for the REPL: Option+Left/Right move by word, Ctrl+W kills back to the start
// of a path component, Option+Backspace / Option+D kill a word.

export type Style = "punctuation" | "pathComponents" | "whitespace";
type Class = "blank" | "newline" | "punctuation" | "word" | "emoji" | "kana" | "cjk" | "hangul";

// vim's character classes, which fish uses: _ is punctuation, not a word character.
export function classOf(c: string): Class {
    const code = c.codePointAt(0)!;
    if (code < 0x100) {
        if (c === "\n") return "newline";
        if (c === " " || c === "\t" || c === "\0" || c === " ") return "blank";
        return /[A-Za-z0-9]/.test(c) || code >= 0xc0 && c !== "×" && c !== "÷" ? "word" : "punctuation";
    }
    if (/\p{Extended_Pictographic}/u.test(c)) return "emoji";
    if (/\s/u.test(c)) return "blank";
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c)) return "kana";
    if (/\p{Script=Han}/u.test(c)) return "cjk";
    if (/\p{Script=Hangul}/u.test(c)) return "hangul";
    return /[\p{P}\p{S}]/u.test(c) ? "punctuation" : "word";
}
const bigwordClass = (c: string): Class => c === "\n" ? "newline" : classOf(c) === "blank" ? "blank" : "word";
const isBlank = (c: string) => classOf(c) === "blank";

// A state machine consumes characters in its direction until it stops.
type Machine = (text: string, at: number) => boolean;

function wordMachine(direction: -1 | 1, classify: (c: string) => Class): Machine {
    let last: Class | undefined;
    return (text, at) => {
        const now = classify(text[at]);
        if (last !== undefined) {
            const stop = direction < 0
                ? last === "blank" ? false : last === "newline" ? now === "newline" : now === "blank" || now === "newline" || now !== last
                : last === "blank" ? now !== "blank" && now !== "newline"
                : last === "newline" ? now !== "blank"
                : now !== "blank" && now !== "newline" && now !== last;
            if (stop) return false;
        }
        last = now;
        return true;
    };
}

// / = { , } ' " : @ # and what ends a shell token separate path components.
const isPathComponentChar = (c: string) => !" \n\t\r\0|;<>/={,}'\":@#".includes(c);
const backslashed = (text: string, at: number) => {
    let n = 0;
    while (at - n - 1 >= 0 && text[at - n - 1] === "\\") n++;
    return n % 2 === 1;
};
type Transition = "blank" | "component" | "punctuation" | "skip";
function pathTransition(text: string, at: number): Transition {
    const c = text[at], escaped = backslashed(text, at);
    if (c === "\\" && !escaped) return "skip";
    return isBlank(c) && !escaped ? "blank" : escaped || isPathComponentChar(c) ? "component" : "punctuation";
}

function pathBackwardMachine(): Machine {
    type S = "initial" | "punctuation" | "component" | "space" | "endComponent" | "endPunctuation";
    let state: S = "initial";
    const next: Record<S, Record<Exclude<Transition, "skip">, S | undefined>> = {
        initial: { blank: "space", component: "component", punctuation: "punctuation" },
        punctuation: { blank: undefined, component: "endComponent", punctuation: "punctuation" },
        component: { blank: undefined, component: "endComponent", punctuation: undefined },
        space: { blank: "space", component: "component", punctuation: "endPunctuation" },
        endComponent: { blank: undefined, component: "endComponent", punctuation: undefined },
        endPunctuation: { blank: undefined, component: undefined, punctuation: "endPunctuation" },
    };
    return (text, at) => {
        const t = pathTransition(text, at);
        if (t === "skip") return true;
        const s = next[state][t];
        if (s === undefined) return false;
        state = s;
        return true;
    };
}

function pathForwardMachine(): Machine {
    type S = "initial" | "component" | "punctuation" | "blank";
    let state: S = "initial";
    return (text, at) => {
        const t = pathTransition(text, at);
        if (t === "skip") return true;
        if (state === "punctuation" && t === "component" || state === "blank" && t !== "blank") return false;
        state = t;
        return true;
    };
}

function machine(style: Style, direction: -1 | 1): Machine {
    if (style === "pathComponents") return direction < 0 ? pathBackwardMachine() : pathForwardMachine();
    return wordMachine(direction, style === "punctuation" ? classOf : bigwordClass);
}

// Where moving a word from pos ends (fish's move_word): toWordEnd runs the
// opposite direction's machine, stopping at a word's last character.
export function moveWord(text: string, pos: number, direction: -1 | 1, style: Style, toWordEnd = false): number {
    const right = direction > 0, end = right ? (toWordEnd ? text.length - 1 : text.length) : toWordEnd ? -1 : 0;
    if (pos === (right ? text.length : 0)) return pos;
    const consume = machine(style, toWordEnd ? (right ? -1 : 1) : direction);
    while (pos !== end) {
        if (pos === text.length && (right || toWordEnd)) {
            if (!right && toWordEnd && pos !== 0) pos--;
            else break;
        }
        const at = right ? (toWordEnd ? pos + 1 : pos) : toWordEnd ? pos : pos - 1;
        if (at < 0 || at >= text.length || !consume(text, at)) break;
        pos += right ? 1 : -1;
    }
    return Math.max(pos, 0);
}

// Emacs forward-word (Option+Right, Option+D): to just past the end of the
// word, or one character on when already at a word's end.
export function forwardWordEnd(text: string, pos: number, style: Style = "punctuation"): number {
    const classify = style === "punctuation" ? classOf : bigwordClass;
    if (pos + 1 < text.length) {
        const now = classify(text[pos]);
        if (now !== "blank" && now !== "newline" && classify(text[pos + 1]) !== now) return pos + 1;
    }
    const at = moveWord(text, pos, 1, style, true);
    return at < text.length ? at + 1 : at;
}
