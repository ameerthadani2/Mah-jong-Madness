/**
 * A line that appears on its own, away from where the player is looking or pressing: the answer to an action,
 * an error, a verdict. Screen readers speak it when it shows: Android and the web through the live region
 * (an alert when `assertive`), iOS, which ignores live regions, through an announcement of `message`.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useAnnounce } from './table/announce';

export function Live({ message, assertive, children, testID, style }: { /** The words to speak on iOS; null speaks nothing. */ message: string | null | undefined; assertive?: boolean; children: React.ReactNode; testID?: string; style?: StyleProp<ViewStyle> }) {
  useAnnounce(message);
  return (
    <View testID={testID} style={style} accessibilityLiveRegion={assertive ? 'assertive' : 'polite'} {...(assertive ? { accessibilityRole: 'alert' as const } : {})}>
      {children}
    </View>
  );
}
