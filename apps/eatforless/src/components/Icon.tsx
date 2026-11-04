// Stroke icons, drawn on a 24×24 grid like the design canvas.

import Svg, { Circle, Path, Rect } from "react-native-svg";
import { C } from "@/theme";

export type IconName =
  | "back" | "chevronDown" | "chevronRight" | "arrowRight" | "bell" | "home" | "receipt" | "search"
  | "basket" | "user" | "heart" | "close" | "plus" | "minus" | "check" | "phone" | "message"
  | "lock" | "shield" | "group" | "pin" | "clock" | "star" | "mic" | "speaker" | "locate"
  | "trash" | "logout" | "cutlery" | "card" | "mail" | "edit";

type Props = { name: IconName; size?: number; color?: string; strokeWidth?: number; fill?: string };

export function Icon({ name, size = 22, color = C.ink, strokeWidth = 2, fill = "none" }: Props) {
  const s = { stroke: color, strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  const body = (() => {
    switch (name) {
      case "back": return <Path d="M15 18l-6-6 6-6" {...s} strokeWidth={2.4} />;
      case "chevronDown": return <Path d="M6 9l6 6 6-6" {...s} strokeWidth={2.6} />;
      case "chevronRight": return <Path d="M9 6l6 6-6 6" {...s} strokeWidth={2.4} />;
      case "arrowRight": return <Path d="M5 12h14M13 6l6 6-6 6" {...s} strokeWidth={2.4} />;
      case "bell": return (<><Path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" {...s} /><Path d="M13.7 21a2 2 0 01-3.4 0" {...s} /></>);
      case "home": return <Path d="M3 11l9-8 9 8v10a1 1 0 01-1 1h-5v-7h-6v7H4a1 1 0 01-1-1z" fill={color} />;
      case "receipt": return (<><Path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" {...s} /><Path d="M9 8h6M9 12h6" {...s} /></>);
      case "search": return (<><Circle cx={11} cy={11} r={7} {...s} strokeWidth={2.2} /><Path d="M20 20l-4-4" {...s} strokeWidth={2.2} /></>);
      case "basket": return (<><Path d="M3 4h2l2.5 11h11L21 7H7" {...s} /><Circle cx={9} cy={20} r={1.5} {...s} /><Circle cx={18} cy={20} r={1.5} {...s} /></>);
      case "user": return (<><Circle cx={12} cy={8} r={4} {...s} /><Path d="M4 21c1-4 4-6 8-6s7 2 8 6" {...s} /></>);
      case "heart": return <Path d="M12 20s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.5-7 10-7 10z" {...s} fill={fill} />;
      case "close": return <Path d="M6 6l12 12M18 6L6 18" {...s} strokeWidth={2.4} />;
      case "plus": return <Path d="M12 5v14M5 12h14" {...s} strokeWidth={2.6} />;
      case "minus": return <Path d="M5 12h14" {...s} strokeWidth={2.6} />;
      case "check": return <Path d="M5 12l5 5 9-10" {...s} strokeWidth={3} />;
      case "phone": return <Path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" {...s} strokeWidth={2.2} fill={fill} />;
      case "message": return <Path d="M4 5h16v11H9l-5 4z" {...s} strokeWidth={2.2} />;
      case "lock": return (<><Rect x={5} y={11} width={14} height={10} rx={2} {...s} /><Path d="M8 11V8a4 4 0 018 0v3" {...s} /></>);
      case "shield": return (<><Path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" {...s} fill={fill} /><Path d="M9 12l2 2 4-4" {...s} /></>);
      case "group": return (<><Circle cx={9} cy={8} r={3.5} {...s} /><Path d="M2.5 20c.8-3.5 3.3-5 6.5-5s5.7 1.5 6.5 5" {...s} /><Path d="M16 4.5a3.5 3.5 0 010 7M18 15c2 .6 3.2 2.2 3.6 5" {...s} /></>);
      case "pin": return (<><Path d="M12 21s-7-6.2-7-11.5A7 7 0 0119 9.5C19 14.8 12 21 12 21z" {...s} /><Circle cx={12} cy={9.5} r={2.5} {...s} /></>);
      case "clock": return (<><Circle cx={12} cy={12} r={9} {...s} /><Path d="M12 7v5l3 2" {...s} /></>);
      case "star": return <Path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill={color} />;
      case "mic": return (<><Rect x={9} y={3} width={6} height={11} rx={3} {...s} /><Path d="M5 11a7 7 0 0014 0M12 18v3" {...s} /></>);
      case "speaker": return (<><Path d="M4 9h4l5-4v14l-5-4H4z" {...s} /><Path d="M17 9a4 4 0 010 6M19.5 6.5a8 8 0 010 11" {...s} /></>);
      case "locate": return (<><Circle cx={12} cy={12} r={7} {...s} /><Circle cx={12} cy={12} r={2.5} fill={color} /><Path d="M12 2v3M12 19v3M2 12h3M19 12h3" {...s} /></>);
      case "trash": return (<><Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" {...s} /></>);
      case "logout": return (<><Path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" {...s} /></>);
      case "cutlery": return <Path d="M7 3v8M5 3v5a2 2 0 004 0V3M7 11v10M17 3c-2 0-3 3-3 6s1 4 3 4v8" {...s} strokeWidth={2.2} />;
      case "card": return (<><Rect x={3} y={5} width={18} height={14} rx={2.5} {...s} /><Path d="M3 10h18" {...s} /></>);
      case "mail": return (<><Rect x={3} y={5} width={18} height={14} rx={2.5} {...s} /><Path d="M4 7l8 6 8-6" {...s} /></>);
      case "edit": return <Path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" {...s} />;
    }
  })();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {body}
    </Svg>
  );
}
