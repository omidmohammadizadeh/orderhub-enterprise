// The animated cuisine row's icons, from the Home artboard.

import { memo } from "react";
import Svg, { Circle, Ellipse, Path, Rect, Text as SvgText } from "react-native-svg";
import { C } from "@/theme";

export type CuisineKind =
  | "pizza" | "burger" | "deal" | "kebab" | "curry" | "chicken" | "fries" | "chinese" | "ice" | "moon" | "drink";

export const CUISINES: Array<{ kind: CuisineKind; label: string; match: RegExp }> = [
  { kind: "pizza", label: "Pizza", match: /pizza/i },
  { kind: "burger", label: "Burgers", match: /burger/i },
  { kind: "deal", label: "Deals", match: /./ },
  { kind: "kebab", label: "Kebab", match: /kebab|grill|turkish/i },
  { kind: "curry", label: "Indian", match: /indian|curry/i },
  { kind: "chicken", label: "Chicken", match: /chicken|wing/i },
  { kind: "fries", label: "Fast food", match: /fast|burger|chicken|chips/i },
  { kind: "chinese", label: "Chinese", match: /chinese|asian/i },
  { kind: "ice", label: "Desserts", match: /dessert|sweet|ice/i },
  { kind: "moon", label: "Late night", match: /./ },
  { kind: "drink", label: "Drinks", match: /drink|coffee|juice/i },
];

export const CuisineIcon = memo(function CuisineIcon({ kind, size = 56 }: { kind: CuisineKind; size?: number }) {
  const box = kind === "deal" ? 60 : 56;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`}>
      {kind === "pizza" && (
        <>
          <Path d="M8 14c13-8 27-8 40 0L28 52z" fill="#F2C75C" />
          <Path d="M8 14c13-8 27-8 40 0l-3 5c-11-6-23-6-34 0z" fill="#D98B3A" />
          <Circle cx={23} cy={24} r={4} fill="#C9432A" />
          <Circle cx={33} cy={30} r={4} fill="#C9432A" />
          <Circle cx={27} cy={38} r={3} fill="#C9432A" />
        </>
      )}
      {kind === "burger" && (
        <>
          <Path d="M8 26c0-12 9-18 20-18s20 6 20 18z" fill="#E09A45" />
          <Path d="M6 30h44v4H6z" fill="#5FA343" />
          <Path d="M8 34h40l-4 4H12z" fill="#F2C238" />
          <Rect x={7} y={37} width={42} height={7} rx={3.5} fill="#5A2E1C" />
          <Path d="M8 45h40c0 4-3 6-7 6H15c-4 0-7-2-7-6z" fill="#E09A45" />
        </>
      )}
      {kind === "kebab" && (
        <>
          <Path d="M14 52L27 6l17 46z" fill="#EFE3CB" />
          <Path d="M19 38l8-28 10 28z" fill="#B5652E" />
          <Path d="M20 34c5-2 9 1 13-1" stroke="#5FA343" strokeWidth={3.5} fill="none" strokeLinecap="round" />
        </>
      )}
      {kind === "curry" && (
        <>
          <Path d="M4 26h40c0 12-9 20-20 20S4 38 4 26z" fill="#E07B2E" />
          <Ellipse cx={24} cy={26} rx={20} ry={6} fill="#C2571E" />
          <Path d="M34 34c8-6 18-2 18 6-4 8-14 8-20 4z" fill="#F3E3C0" />
        </>
      )}
      {kind === "chicken" && (
        <>
          <Path d="M30 8c10 0 18 8 16 18-2 9-11 13-19 10l-9 9" fill="#D9772E" />
          <Path d="M30 8c-9 0-15 7-14 15 1 6 5 11 11 13 8 3 17-1 19-10 2-10-6-18-16-18z" fill="#E88A3A" />
          <Path d="M18 45l-6 6M14 41l-5-1M19 48l1 5" stroke="#F3E9D6" strokeWidth={4} strokeLinecap="round" />
        </>
      )}
      {kind === "fries" && (
        <>
          <Path d="M18 26l-3-18M24 26l-1-20M30 26l1-21M36 26l3-18M27 26l-6-17M33 26l5-16" stroke="#F2C238" strokeWidth={5} strokeLinecap="round" />
          <Path d="M12 24h32l-4 28H16z" fill="#D7312A" />
        </>
      )}
      {kind === "deal" && (
        <>
          <Path d="M30 2l6 6 8-2 2 8 8 2-2 8 6 6-6 6 2 8-8 2-2 8-8-2-6 6-6-6-8 2-2-8-8-2 2-8-6-6 6-6-2-8 8-2 2-8 8 2z" fill={C.ink} />
          <SvgText x={30} y={30} textAnchor="middle" fontFamily="InterTight_800ExtraBold" fontSize={15} fill={C.lime}>30%</SvgText>
          <SvgText x={30} y={43} textAnchor="middle" fontFamily="Inter_800ExtraBold" fontSize={9} fill={C.lime}>OFF</SvgText>
        </>
      )}
      {kind === "ice" && (
        <>
          <Path d="M16 28h24l-12 26z" fill="#E2A54A" />
          <Circle cx={22} cy={22} r={9} fill="#F8C9D8" />
          <Circle cx={34} cy={22} r={9} fill="#FDF3E3" />
          <Circle cx={28} cy={13} r={9} fill="#8A4B2A" />
          <Circle cx={29} cy={5} r={3} fill="#C9432A" />
        </>
      )}
      {kind === "chinese" && (
        <>
          <Path d="M10 18h36l-5 34H15z" fill="#D7312A" />
          <Path d="M10 18l6-10h24l6 10z" fill="#B42520" />
          <Path d="M24 4c2 6 2 12 0 16M32 4c-2 6-2 12 0 16" stroke="#F2C238" strokeWidth={3} strokeLinecap="round" />
          <Circle cx={28} cy={34} r={6} fill="#F2C238" />
        </>
      )}
      {kind === "moon" && (
        <>
          <Path d="M34 6a22 22 0 1016 34A18 18 0 0134 6z" fill="#F2C238" />
          <Circle cx={44} cy={12} r={2} fill="#F2C238" />
          <Circle cx={50} cy={22} r={1.5} fill="#F2C238" />
        </>
      )}
      {kind === "drink" && (
        <>
          <Rect x={16} y={8} width={24} height={44} rx={6} fill="#B4231B" />
          <Rect x={16} y={22} width={24} height={12} fill="#FFFFFF" opacity={0.85} />
          <Ellipse cx={28} cy={9} rx={10} ry={3} fill="#9A9A9A" />
        </>
      )}
    </Svg>
  );
});
