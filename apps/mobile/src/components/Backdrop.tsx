import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, Ellipse, G, Line, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { colors } from '../theme';

/** Puffy flat cloud: white body over a pale-blue underside, no outline (they stay in the background). */
function Cloud({ x, y, s, o = 1 }: { x: number; y: number; s: number; o?: number }) {
  const body = (fill: string, dy: number) => (
    <G transform={`translate(0 ${dy})`}>
      <Circle cx={22} cy={30} r={20} fill={fill} />
      <Circle cx={50} cy={20} r={27} fill={fill} />
      <Circle cx={80} cy={28} r={21} fill={fill} />
      <Circle cx={100} cy={38} r={13} fill={fill} />
      <Rect x={10} y={30} width={100} height={21} rx={10.5} fill={fill} />
    </G>
  );
  return (
    <G transform={`translate(${x} ${y}) scale(${s})`} opacity={o}>
      {body(colors.cloudShade, 6)}
      {body(colors.cloud, 0)}
      <Ellipse cx={46} cy={10} rx={10} ry={4} fill="#FFFFFF" opacity={0.9} />
    </G>
  );
}

/** Sky-to-aqua lobby background with a soft sunburst and drifting clouds. */
export function SkyBackdrop() {
  const { width, height } = useWindowDimensions();
  const cx = width / 2;
  const rays = 18;
  const R = Math.hypot(width, height);
  const unit = Math.min(1.25, Math.max(0.55, Math.min(width, height) / 520));
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={[colors.skyTop, colors.sky, colors.skyLight, colors.aqua]} locations={[0, 0.38, 0.78, 1]} style={StyleSheet.absoluteFill} />
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <G opacity={0.08}>
          {Array.from({ length: rays }).map((_, i) => {
            const a0 = (i / rays) * Math.PI * 2;
            const a1 = a0 + Math.PI / rays;
            return <Path key={i} d={`M${cx} ${-40} L${cx + Math.cos(a0) * R} ${-40 + Math.sin(a0) * R} L${cx + Math.cos(a1) * R} ${-40 + Math.sin(a1) * R} Z`} fill="#FFFFFF" />;
          })}
        </G>
        <Cloud x={-30 * unit} y={height * 0.08} s={1.1 * unit} />
        <Cloud x={width * 0.62} y={height * 0.03} s={0.8 * unit} o={0.9} />
        <Cloud x={width * 0.3} y={height * 0.42} s={0.55 * unit} o={0.6} />
        <Cloud x={width - 90 * unit} y={height * 0.55} s={1.2 * unit} o={0.85} />
        <Cloud x={-20 * unit} y={height * 0.78} s={0.9 * unit} o={0.75} />
        <Path d={`M0 ${height} L0 ${height - 34 * unit} Q${width * 0.22} ${height - 70 * unit} ${width * 0.45} ${height - 30 * unit} Q${width * 0.7} ${height - 6 * unit} ${width} ${height - 52 * unit} L${width} ${height} Z`} fill="#7BE3C4" opacity={0.45} />
      </Svg>
    </View>
  );
}

/** Parlour floor behind the table: deep blue with a faint diamond tiling and a warm centre glow. */
export function TableBackdrop() {
  const { width, height } = useWindowDimensions();
  const step = 56;
  const lines: React.ReactNode[] = [];
  for (let k = -height; k < width + height; k += step) {
    lines.push(<Line key={`a${k}`} x1={k} y1={0} x2={k + height} y2={height} stroke="#FFFFFF" strokeWidth={1.5} />);
    lines.push(<Line key={`b${k}`} x1={k} y1={height} x2={k + height} y2={0} stroke="#FFFFFF" strokeWidth={1.5} />);
  }
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={width} height={height}>
        <Defs>
          <RadialGradient id="floorGlow" cx="50%" cy="45%" r="70%">
            <Stop offset="0" stopColor="#2A5F8F" />
            <Stop offset="0.6" stopColor="#173B5C" />
            <Stop offset="1" stopColor="#0C2238" />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill="url(#floorGlow)" />
        <G opacity={0.06}>{lines}</G>
      </Svg>
    </View>
  );
}
