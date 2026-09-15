import { describe, expect, test } from "bun:test";
import {
	decodeKeys,
	printable,
	shellQuote,
	shiftedUs,
	usLayoutKey,
} from "./term.ts";

const keys = (s: string) => decodeKeys(Buffer.from(s, "utf8"));
/** What the picker switches on: the US key, or the key's name. */
const commands = (s: string) =>
	keys(s).map((k) => (k.name === "char" ? (k.base ?? k.char) : k.name));

describe("printable", () => {
	test("control characters become visible stand-ins", () => {
		expect(printable("bad\nname.jpg")).toBe("bad␊name.jpg");
		expect(printable("\x1b]0;owned\x07x")).toBe("␛]0;owned␇x");
		expect(printable("del\x7f c1")).toBe("del␡ c1�");
		expect(printable("rtl‮gpj.exe")).toBe("rtl�gpj.exe");
	});

	test("ordinary names stay as they are", () => {
		expect(printable("Отпуск на море 2024.jpg")).toBe(
			"Отпуск на море 2024.jpg",
		);
		expect(printable("100%done [1].jpg")).toBe("100%done [1].jpg");
	});
});

describe("shellQuote", () => {
	test("bare, single-quoted, and $'…' with controls", () => {
		expect(shellQuote("/a/photo.jpg")).toBe("/a/photo.jpg");
		expect(shellQuote("0:a?")).toBe("'0:a?'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		expect(shellQuote("bad\nname's\x1b.jpg")).toBe(
			"$'bad\\x0aname\\'s\\x1b.jpg'",
		);
		expect(shellQuote("")).toBe("''");
	});

	test("$'…' reads back as the same bytes in a real shell", async () => {
		const name = "bad\nname's\x1b\\x.jpg";
		const proc = Bun.spawn(["bash", "-c", `printf %s ${shellQuote(name)}`], {
			stdout: "pipe",
		});
		expect(await new Response(proc.stdout).text()).toBe(name);
	});
});

describe("layout keys", () => {
	test("shifted US keys", () => {
		expect(shiftedUs("/")).toBe("?");
		expect(shiftedUs(".")).toBe(">");
		expect(shiftedUs("h")).toBe("H");
		expect(shiftedUs("?")).toBe("?");
	});

	test("upper-case Cyrillic is the shifted US key", () => {
		expect(usLayoutKey("р")).toBe("h");
		expect(usLayoutKey("Р")).toBe("H");
		expect(usLayoutKey("Ю")).toBe(">");
		expect(usLayoutKey("constructor")).toBeUndefined();
	});

	test("legacy keys", () => {
		expect(commands("jР.ю/?")).toEqual(["j", "H", ".", ".", "/", "?"]);
	});
});

describe("kitty keys", () => {
	test("lone modifiers and other functional keys are not typed", () => {
		// left shift, caps lock, media play
		expect(keys("\x1b[57441;2u\x1b[57358u\x1b[57428u")).toEqual([]);
	});

	test("keypad keys map to what they mean", () => {
		expect(commands("\x1b[57414u\x1b[57419u\x1b[57420u\x1b[57421u")).toEqual([
			"enter",
			"up",
			"down",
			"pageup",
		]);
		expect(commands("\x1b[57401u")).toEqual(["2"]);
	});

	test("shift on ЙЦУКЕН follows the US key: shift + the / key is ?", () => {
		// typed "," (46 shifted to 44), base-layout key "/" (47), shift held
		expect(commands("\x1b[46:44:47;2u")).toEqual(["?"]);
		// р with shift is Р; its base key h with shift is H
		expect(commands("\x1b[1088:1056:104;2u")).toEqual(["H"]);
		// plain ю is the US "." key
		expect(commands("\x1b[1102::46u")).toEqual(["."]);
	});

	test("shift on a US layout", () => {
		expect(commands("\x1b[104:72;2u")).toEqual(["H"]);
		expect(commands("\x1b[47:63;2u")).toEqual(["?"]);
	});

	test("ctrl-c and a key release", () => {
		expect(commands("\x1b[99;5u")).toEqual(["ctrl-c"]);
		expect(keys("\x1b[106;1:3u")).toEqual([]);
	});
});
