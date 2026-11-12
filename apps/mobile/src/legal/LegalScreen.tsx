/**
 * The bundled Terms of Service or Privacy Policy, under a "DRAFT — pending counsel review"
 * banner. Shown in a full-screen modal by components/LegalLinks.tsx (so it opens from any
 * screen without a route), or rendered directly by a route if one is added later.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useT } from '../i18n';
import { colors, fonts, space } from '../theme';
import { Card, fontFor, H2, P, ScreenHeader } from '../components/Ui';
import { Icon } from '../components/Icons';
import { legalDocument } from './documents';
import type { LegalDoc } from './links';
import { SUPPORT, supportAddress } from './support';

export function LegalScreen({ doc, onBack }: { doc: LegalDoc; onBack: () => void }) {
  const { t, locale } = useT();
  const d = legalDocument(doc, locale, supportAddress(SUPPORT));
  return (
    <ScrollView contentContainerStyle={styles.wrap} testID={`legal-${doc}`}>
      <ScreenHeader title={d.title} onBack={onBack} backTestID="legal-back" />
      <View style={styles.banner} accessibilityRole="alert">
        <Icon name="warning" size={22} />
        <Text style={[styles.bannerText, fontFor(t('legal.draftBanner'), fonts.uiBold)]}>{t('legal.draftBanner')}</Text>
      </View>
      <Card style={{ gap: space.md }}>
        <P dim style={{ fontSize: 12 }}>
          {t('legal.version', { version: d.version })}
        </P>
        {d.sections.map((s) => (
          <View key={s.heading} style={{ gap: 6 }}>
            <H2 style={{ fontSize: 17 }}>{s.heading}</H2>
            {s.paragraphs.map((p, i) => (
              <P key={i} style={{ fontSize: 14, lineHeight: 21 }}>
                {p}
              </P>
            ))}
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.gold, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  bannerText: { flex: 1, color: colors.ink, fontSize: 14, fontFamily: fonts.uiBold },
});
