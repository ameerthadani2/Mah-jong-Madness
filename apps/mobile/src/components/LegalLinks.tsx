/**
 * Terms of Service and Privacy Policy links, and the "no monetary value" notice.
 *
 * A link opens the published page in the browser when the build carries
 * EXPO_PUBLIC_TERMS_URL / EXPO_PUBLIC_PRIVACY_URL, and otherwise the bundled DRAFT text in a
 * full-screen sheet (src/legal/LegalScreen.tsx), so it works from any screen without a route.
 */
import React, { useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useT } from '../i18n';
import { legalTarget, readLegalEnv, type LegalDoc } from '../legal/links';
import { LegalScreen } from '../legal/LegalScreen';
import { colors, fonts } from '../theme';
import { fontFor } from './Ui';
import { Icon } from './Icons';

const LEGAL_ENV = readLegalEnv();

/** Opens a legal document; render `sheet` somewhere in the tree. */
export function useLegalSheet(): { open(doc: LegalDoc): void; sheet: React.ReactNode } {
  const [doc, setDoc] = useState<LegalDoc | null>(null);
  const open = (d: LegalDoc) => {
    const target = legalTarget(d, LEGAL_ENV);
    if (target.kind === 'url') void Linking.openURL(target.url).catch(() => setDoc(d));
    else setDoc(d);
  };
  const sheet = (
    <Modal visible={doc !== null} animationType="slide" onRequestClose={() => setDoc(null)}>
      <View style={styles.sheet}>
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom', 'left', 'right']}>
          {doc && <LegalScreen doc={doc} onBack={() => setDoc(null)} />}
        </SafeAreaView>
      </View>
    </Modal>
  );
  return { open, sheet };
}

export function LegalLinks({ style, dark }: { style?: StyleProp<ViewStyle>; dark?: boolean }) {
  const { t } = useT();
  const { open, sheet } = useLegalSheet();
  const link = (doc: LegalDoc, label: string) => (
    <Pressable testID={`open-${doc}`} accessibilityRole="link" onPress={() => open(doc)} hitSlop={8} style={styles.link}>
      <Text style={[styles.linkText, dark && { color: '#FFFFFF' }, fontFor(label, fonts.uiBold)]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={[styles.row, style]}>
      {link('terms', t('legal.terms'))}
      <Text style={[styles.dot, dark && { color: '#FFFFFF' }]}>·</Text>
      {link('privacy', t('legal.privacy'))}
      {sheet}
    </View>
  );
}

/** "Diamonds and points have no monetary value and cannot be redeemed or transferred." */
export function NoValueNotice({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useT();
  return (
    <View style={[styles.notice, style]} testID="no-value-notice">
      <Icon name="shield" size={18} />
      <Text style={[styles.noticeText, fontFor(t('legal.noValue'), fonts.bodyBold, '700')]}>{t('legal.noValue')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.sky },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' },
  link: { minHeight: 32, justifyContent: 'center' },
  // Ink, underlined: the links also sit straight on the sky backdrop (the Shop's foot), where blue was 4.2:1.
  linkText: { fontFamily: fonts.uiBold, color: colors.inkSoft, fontSize: 13, textDecorationLine: 'underline' },
  dot: { color: colors.inkDim, fontSize: 13 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 2, borderColor: colors.ink, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 },
  noticeText: { flex: 1, fontFamily: fonts.bodyBold, color: colors.ink, fontSize: 12, lineHeight: 16 },
});
