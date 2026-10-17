// The REPL's word motions are fish's: its own test cases (src/reader/word_motion.rs),
// where each ^ marks where a motion from the previous one stops.
import { forwardWordEnd, moveWord, type Style } from "../src/word-motion.ts";

function validate(direction: -1 | 1, style: Style, line: string) {
    let text = "";
    const stops: number[] = [];
    for (const c of line) {
        if (c === "^") stops.push(text.length);
        else text += c;
    }
    if (direction < 0) stops.reverse();
    const visited = [stops[0]];
    for (let pos = stops[0], n = 1; n < stops.length; n++) visited.push(pos = moveWord(text, pos, direction, style));
    if (JSON.stringify(visited) !== JSON.stringify(stops)) throw new Error(`${JSON.stringify(text)}: ${visited} != ${stops}`);
}

for (const [direction, style, line] of [
    [-1, "pathComponents", "^echo ^/^foo/^bar{^aaa,^bbb,^ccc}^bak/^"],
    [-1, "pathComponents", "^echo ^bak ^///^"],
    [-1, "pathComponents", "^aaa ^@ ^@^aaa^"],
    [-1, "pathComponents", "^aaa ^a ^@^aaa^"],
    [-1, "pathComponents", "^aaa ^@@@ ^@@^aa^"],
    [-1, "pathComponents", "^aa^@@  ^aa@@^a^"],
    [-1, "pathComponents", String.raw`^a\  ^b\ c/^d"^e\ f"^g`],
    [-1, "pathComponents", String.raw`^a\  ^b\ c/^d"^e\\\ f"^g`],
    [-1, "pathComponents", String.raw`^a\;b^`],
    [-1, "pathComponents", String.raw`^a\"bc^`],
    [1, "pathComponents", "^/^foo/^bar/^baz/^"],
    [1, "pathComponents", "^echo ^--foo ^--bar^"],
    [1, "pathComponents", "^echo ^hi ^> ^/^dev/^null^"],
    [1, "pathComponents", "^echo ^/^foo/^bar{^aaa,^ccc}^bak/^"],
    [1, "pathComponents", "^echo ^bak ^///^"],
    [1, "pathComponents", "^aaa ^@ ^@^aaa^"],
    [1, "pathComponents", "^aa@@ ^aa@@^a^"],
    [-1, "punctuation", "^a ^bcd^"],
    [-1, "punctuation", "^ab ^cd^e"],
    [-1, "punctuation", "^ab ^c^de"],
    [-1, "punctuation", "^ab ^cde^"],
    [1, "punctuation", "^a ^bcd^"],
    [1, "punctuation", "a^b ^cde^"],
    [1, "punctuation", "ab^ ^cde^"],
    [1, "punctuation", "^ab ^cde^"],
    [-1, "punctuation", "^echo ^hello^_^world^.^txt^"],
    [1, "punctuation", "^echo ^hello^_^world^.^txt^"],
    [-1, "punctuation", "^echo ^foo^__^foo^_^foo^//    ^"],
    [1, "punctuation", "^echo ^foo^__^foo^_^foo^//^"],
    [1, "punctuation", "^ab^&^cd ^& ^e ^f^&^"],
    [-1, "punctuation", "^ab^&^cd ^& ^e ^f^&^"],
    [1, "punctuation", "^a^-^a^-^a^"],
    [1, "punctuation", "^aa^-^aa^-^aa^"],
    [-1, "whitespace", "^a ^bcd^"],
    [-1, "whitespace", "^ab ^cd^e"],
    [-1, "whitespace", "^ab ^c^de"],
    [-1, "whitespace", "^ab ^cde^"],
    [1, "whitespace", "^a ^bcd^"],
    [1, "whitespace", "a^b ^cde^"],
    [1, "whitespace", "ab^ ^cde^"],
    [1, "whitespace", "^ab ^cde^"],
    [1, "punctuation", "^a \n ^bcd^"],
    [-1, "punctuation", "^a \n ^bcd^"],
    [1, "whitespace", "^a \n ^bcd^"],
    [-1, "whitespace", "^a \n ^bcd^"],
    [1, "punctuation", "^a\n^\n^b^-^cd^"],
    [-1, "punctuation", "^a\n^\n^b^_^cd^"],
    [1, "whitespace", "^a\n^\n^b_cd^"],
    [-1, "whitespace", "^a\n^\n^b_cd^"],
    [1, "punctuation", "^a \n  \n \n^\n ^bcd^"],
    [-1, "punctuation", "^a \n  \n \n^\n ^bcd^"],
    [1, "whitespace", "^a \n  \n \n^\n ^bcd^"],
    [-1, "whitespace", "^a \n  \n \n^\n ^bcd^"],
    [1, "punctuation", "^hello ^中^@^文^あいう^漢字^"],
    [-1, "punctuation", "^hello ^中^@^文^あいう^漢字^"],
    [1, "whitespace", "^hello ^中文あいう漢字^"],
    [-1, "whitespace", "^hello ^中文あいう漢字^"],
    [1, "punctuation", "^café ^naïve^"],
    [-1, "punctuation", "^café ^naïve^"],
] as const) Deno.test(`fish word motion ${direction < 0 ? "left" : "right"} ${style}: ${JSON.stringify(line)}`, () => validate(direction, style, line));

Deno.test("Option+Right moves to the end of a word, as fish's emacs forward-word", () => {
    const text = "map (x -> x_value + 1) xs", stops: number[] = [];
    for (let pos = 0; pos < text.length;) stops.push(pos = forwardWordEnd(text, pos));
    const want = [3, 5, 6, 9, 11, 12, 17, 19, 21, 22, 25]; // ( and -> are words of punctuation
    if (JSON.stringify(stops) !== JSON.stringify(want)) throw new Error(`${stops} != ${want}`);
});
