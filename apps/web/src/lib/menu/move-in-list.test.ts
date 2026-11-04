import { describe, expect, it } from "vitest";
import { moveInList } from "./move-in-list";

describe("moveInList", () => {
  it("moves a row up one place", () => {
    expect(moveInList(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
  });

  it("moves a row down one place", () => {
    expect(moveInList(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("leaves the list alone past either end", () => {
    const list = ["a", "b"];
    expect(moveInList(list, 0, -1)).toBe(list);
    expect(moveInList(list, 1, 1)).toBe(list);
  });

  it("never mutates the list it was given", () => {
    const list = ["a", "b", "c"];
    moveInList(list, 0, 1);
    expect(list).toEqual(["a", "b", "c"]);
  });
});
