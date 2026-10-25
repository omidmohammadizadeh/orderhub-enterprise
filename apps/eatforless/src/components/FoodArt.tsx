// The design canvas's illustrated food tiles ("Food photo tile" component),
// used wherever a shop or item has no photo yet. Drawn on a 320×180 board and
// cropped to fill, so one drawing serves every card shape.

import { memo } from "react";
import { View, type ViewStyle } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";
import type { FoodKind } from "@/lib/menu";

export const FOOD_BG: Record<FoodKind, string> = {
  pizza: "#F5E6D6",
  burger: "#F3EBD3",
  kebab: "#EAF0E4",
  dessert: "#F8E4EC",
  curry: "#F4E2CF",
  chicken: "#F6E0D6",
  fries: "#F3EBD3",
  drink: "#F3F3F3",
  chinese: "#F6E0D6",
};

function Art({ kind }: { kind: FoodKind }) {
  switch (kind) {
    case "pizza":
      return (
        <G>
          <Circle cx={210} cy={96} r={104} fill="#E2A54A" />
          <Circle cx={210} cy={96} r={92} fill="#C9432A" />
          <Circle cx={210} cy={96} r={86} fill="#F2C75C" />
          <Path d="M210 10v172M124 96h172M149 35l122 122M271 35L149 157" stroke="#E2A54A" strokeWidth={3} />
          <Circle cx={176} cy={66} r={12} fill="#A9301C" />
          <Circle cx={242} cy={60} r={12} fill="#A9301C" />
          <Circle cx={248} cy={124} r={12} fill="#A9301C" />
          <Circle cx={182} cy={130} r={12} fill="#A9301C" />
          <Circle cx={212} cy={96} r={10} fill="#A9301C" />
          <Circle cx={160} cy={98} r={4} fill="#3E7A3A" />
          <Circle cx={262} cy={92} r={4} fill="#3E7A3A" />
          <Circle cx={222} cy={150} r={4} fill="#3E7A3A" />
          <Circle cx={60} cy={140} r={26} fill="#FFFFFF" opacity={0.6} />
          <Circle cx={60} cy={140} r={18} fill="#C9432A" />
        </G>
      );
    case "burger":
      return (
        <G>
          <Path d="M96 92c0-46 30-70 74-70s74 24 74 70z" fill="#D98B3A" />
          <Ellipse cx={146} cy={46} rx={5} ry={3} fill="#F6E1B5" />
          <Ellipse cx={178} cy={38} rx={5} ry={3} fill="#F6E1B5" />
          <Ellipse cx={202} cy={58} rx={5} ry={3} fill="#F6E1B5" />
          <Path d="M90 98c20 8 30-6 44 2s28-6 42 2 28-6 42 2 20-6 30 0v-10H90z" fill="#5FA343" />
          <Path d="M96 104h148l-14 18H110z" fill="#F2C238" />
          <Rect x={92} y={112} width={156} height={22} rx={11} fill="#5A2E1C" />
          <Path d="M96 138h148c0 12-10 20-22 20H118c-12 0-22-8-22-20z" fill="#D98B3A" />
          <Path d="M262 150l6-60M276 150l2-62M290 150l-3-58" stroke="#F2C238" strokeWidth={9} strokeLinecap="round" />
          <Path d="M252 112h50l-6 50h-38z" fill="#C9432A" />
        </G>
      );
    case "kebab":
      return (
        <G>
          <Path d="M110 176L160 14l62 162z" fill="#EFE3CB" />
          <Path d="M126 128l36-96 42 96z" fill="#B5652E" />
          <Path d="M130 118c14-6 26 4 40-2s20 4 30 2" stroke="#5FA343" strokeWidth={8} fill="none" strokeLinecap="round" />
          <Path d="M140 92c10-4 20 2 28-2s14 2 22 0" stroke="#C9432A" strokeWidth={7} fill="none" strokeLinecap="round" />
          <Circle cx={258} cy={120} r={34} fill="#FFFFFF" opacity={0.7} />
          <Circle cx={258} cy={120} r={24} fill="#E9E2D0" />
          <Path d="M244 120h28" stroke="#C9432A" strokeWidth={6} strokeLinecap="round" />
        </G>
      );
    case "dessert":
      return (
        <G>
          <Circle cx={120} cy={100} r={58} fill="#D9A066" />
          <Circle cx={120} cy={100} r={50} fill="#E8789A" />
          <Circle cx={120} cy={100} r={18} fill="#F7E7EE" />
          <Path d="M96 70l6 4M140 66l-4 6M150 110l6 2M92 120l6-4M120 140l2 6M126 60l4-6" stroke="#FFFFFF" strokeWidth={4} strokeLinecap="round" />
          <Path d="M214 100h64l-12 64h-40z" fill="#F2C238" />
          <Circle cx={246} cy={84} r={30} fill="#FDF3E3" />
          <Circle cx={230} cy={70} r={18} fill="#8A4B2A" />
          <Circle cx={262} cy={74} r={16} fill="#E8789A" />
          <Circle cx={246} cy={52} r={8} fill="#C9432A" />
        </G>
      );
    case "curry":
      return (
        <G>
          <Ellipse cx={140} cy={104} rx={96} ry={60} fill="#2F2F2F" />
          <Ellipse cx={140} cy={98} rx={84} ry={48} fill="#C2571E" />
          <Circle cx={112} cy={90} r={10} fill="#F2E3C6" />
          <Circle cx={150} cy={104} r={12} fill="#F2E3C6" />
          <Circle cx={170} cy={84} r={9} fill="#F2E3C6" />
          <Path d="M104 112l8-4M184 104l8 2M130 78l6 6" stroke="#5FA343" strokeWidth={4} strokeLinecap="round" />
          <Path d="M236 40c40-10 70 20 66 60-4 44-50 70-80 56 30-20 36-80 14-116z" fill="#E7C27C" />
          <Circle cx={262} cy={80} r={5} fill="#B5652E" />
          <Circle cx={276} cy={110} r={5} fill="#B5652E" />
        </G>
      );
    case "chicken":
    case "chinese":
      return (
        <G>
          <Path d="M120 80h96l-12 96h-72z" fill="#FFFFFF" />
          <Path d="M132 80h14l-4 96h-10zM164 80h14v96h-14zM198 80h14l-6 96h-10z" fill="#C9432A" />
          <Ellipse cx={146} cy={66} rx={28} ry={22} fill="#C9772E" />
          <Ellipse cx={192} cy={60} rx={30} ry={24} fill="#B8692A" />
          <Ellipse cx={168} cy={52} rx={24} ry={20} fill="#D38A3C" />
          <Path d="M240 140c20-30 50-30 62-14-6 20-30 30-62 14z" fill="#C9772E" />
          <Path d="M236 142l-14 10" stroke="#F3E9D6" strokeWidth={7} strokeLinecap="round" />
        </G>
      );
    case "fries":
      return (
        <G>
          <Path d="M130 70l-8-50M150 70l-2-56M170 70l3-58M190 70l8-50M160 70l-14-46M180 70l12-44" stroke="#F2C238" strokeWidth={13} strokeLinecap="round" />
          <Path d="M112 64h96l-12 100h-72z" fill="#D7312A" />
          <Path d="M140 112h40" stroke="#FFFFFF" strokeWidth={8} strokeLinecap="round" />
        </G>
      );
    case "drink":
      return (
        <G>
          <Rect x={136} y={30} width={56} height={124} rx={14} fill="#B4231B" />
          <Rect x={136} y={66} width={56} height={40} fill="#FFFFFF" opacity={0.9} />
          <Rect x={144} y={20} width={40} height={14} rx={5} fill="#9A9A9A" />
        </G>
      );
  }
}

type Props = { kind: FoodKind; style?: ViewStyle };

export const FoodArt = memo(function FoodArt({ kind, style }: Props) {
  return (
    <View style={[{ backgroundColor: FOOD_BG[kind], overflow: "hidden" }, style]}>
      <Svg width="100%" height="100%" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
        <Art kind={kind} />
      </Svg>
    </View>
  );
});
