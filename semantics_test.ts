import { Interpreter } from "./src/interp.ts";
import { parse } from "./main.ts";

// Exercise APN source and observable output, without dependencies or runtime mocks.
function execute(source: string): string[] {
    const output: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
        new Interpreter().run(parse(source));
    } finally {
        console.log = log;
    }
    return output;
}

function example(name: string, source: string, expected: string[]) {
    Deno.test(name, () => {
        const actual = execute(source);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    });
}

function failure(name: string, source: string, message: string) {
    Deno.test(name, () => {
        try {
            execute(source);
        } catch (error) {
            if (error instanceof Error && error.message.includes(message)) return;
            throw error;
        }
        throw new Error(`Expected error containing: ${message}`);
    });
}

example("definitions defer their bodies", `
unused = missing + 1
action = print "unexpected"
print 42
`, ["42"]);

example("separate native calls currently recompute value bindings", `
value = (print 2) + 1
print value
print value
`, ["2", "3", "2", "3"]);

example("actions repeat when demanded", `
action = { print "run"; 3 }
print action
print action
`, ["run", "3", "run", "3"]);

example("application and pipe bodies are repeatable actions", `
action = print 3
piped = 4 $ print
action
action
piped
piped
`, ["3", "3", "4", "4"]);

example("bare value statements also re-evaluate their body", `
value = (print 2) + 1
print value
value
print value
`, ["2", "3", "2", "2", "3"]);

example("unforced values see later bindings in their lexical environment", `
n = 1
value = n + 1
n = 10
print value
`, ["11"]);

example("block bindings shadow their parent scope", `
n = 1
action = { n = 10; n + 1 }
print action
print n
`, ["11", "1"]);

example("unused variable arguments remain unevaluated", `
first x y = x
other = x y -> x
print (first 7 missing)
print (other 8 missing)
`, ["7", "8"]);

example("pattern fallthrough demands a side-effecting argument once", `
choose 0 = 0
choose 1 = 10
choose x = x
print (choose (print 2))
`, ["2", "2"]);

example("ternary evaluates only the selected branch", `
print (true ? 7 : missing)
print (false ? missing : 8)
`, ["7", "8"]);

example("quote and toAST do not evaluate their arguments", `
print (quote missing)
print (toAST (1 + missing))
`, ["missing", '["+", 1, "missing"]']);

example("debug inspects an action without calling its body", `
action = print "unexpected"
debug action
`, ["action"]);

example("finite and infinite ranges support head", `
print (head [3..5])
print (head [3..])
`, ["3", "3"]);

failure("head forces every element of a list literal",
    "print (head [1, missing])", "unbound variable 'missing'");
failure("list forcing also traverses nested lists",
    "print (head [1, [missing]])", "unbound variable 'missing'");
failure("a pattern clause demands even an otherwise unused argument",
    "first 0 y = 7\nprint (first 0 missing)", "unbound variable 'missing'");
failure("arithmetic does not coerce int to float",
    "print (1 + 2.0)", "cannot apply '+' to int and float");

example("repeated native demand observes later rebinding", `
n = 1
value = n + 1
print value
n = 10
print value
`, ["2", "11"]);
