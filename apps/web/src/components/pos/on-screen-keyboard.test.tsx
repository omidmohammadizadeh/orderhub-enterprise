import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { OnScreenKeyboard } from "./on-screen-keyboard";
import { useDeviceStore } from "@/stores/device.store";

function Till() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  return (
    <>
      <input aria-label="Customer name" value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <div data-osk="off">
        <input aria-label="Own keypad" />
      </div>
      <OnScreenKeyboard />
    </>
  );
}

const key = (name: string) => screen.getByRole("button", { name });

describe("OnScreenKeyboard", () => {
  beforeEach(() => {
    // jsdom has no matchMedia; a mouse-driven screen, so "auto" would be off.
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    useDeviceStore.setState({ keyboardMode: "on", keyboardLanguages: ["en"], keyboardLanguage: "en" });
  });

  it("types into a React field and keeps the system keyboard shut", () => {
    render(<Till />);
    const name = screen.getByLabelText("Customer name") as HTMLInputElement;
    act(() => name.focus());
    expect(name.getAttribute("inputmode")).toBe("none");
    expect(screen.getByRole("group", { name: "On-screen keyboard" })).toBeInTheDocument();

    // Starts capitalised for the first letter of a name, then drops shift.
    fireEvent.pointerDown(key("Q"));
    fireEvent.pointerDown(key("a"));
    fireEvent.pointerDown(key("1"));
    expect(name.value).toBe("Qa1");
    fireEvent.pointerDown(key("Backspace"));
    expect(name.value).toBe("Qa");
  });

  it("shows the numpad for a phone field", () => {
    render(<Till />);
    act(() => (screen.getByLabelText("Phone") as HTMLInputElement).focus());
    expect(screen.queryByRole("button", { name: "q" })).toBeNull();
    fireEvent.pointerDown(key("+"));
    fireEvent.pointerDown(key("4"));
    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("+4");
  });

  it("stays away from a field that opted out, and when switched off", () => {
    render(<Till />);
    act(() => (screen.getByLabelText("Own keypad") as HTMLInputElement).focus());
    expect(screen.queryByRole("group", { name: "On-screen keyboard" })).toBeNull();

    const name = screen.getByLabelText("Customer name") as HTMLInputElement;
    act(() => name.focus());
    act(() => useDeviceStore.setState({ keyboardMode: "off" }));
    expect(screen.queryByRole("group", { name: "On-screen keyboard" })).toBeNull();
    expect(name.hasAttribute("inputmode")).toBe(false);
  });
});
