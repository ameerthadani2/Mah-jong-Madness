/**
 * The birth-year age gate (src/legal/age.ts for the rules, src/legal/useAgeGate.ts for state).
 * `AgeGate` asks; `AgeBlocked` is the polite screen for players under the limit.
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useT } from '../i18n';
import { AGE_LIMIT, allowedFromYear, parseBirthYear } from '../legal/age';
import { useAgeGate } from '../legal/useAgeGate';
import { colors, fonts, space } from '../theme';
import { Button, Card, fontFor, P, ScreenHeader } from './Ui';
import { Icon } from './Icons';
import { Logo } from './Logo';
import { LegalLinks } from './LegalLinks';

export function AgeGate({ onBack }: { onBack?: () => void }) {
  const { t } = useT();
  const gate = useAgeGate();
  const [year, setYear] = useState('');
  const [invalid, setInvalid] = useState(false);
  const submit = () => {
    const y = parseBirthYear(year, new Date().getFullYear());
    if (y === null) setInvalid(true);
    else gate.confirm(y);
  };
  if (gate.status === 'blocked') return <AgeBlocked onBack={onBack} />;
  return (
    <ScrollView contentContainerStyle={styles.wrap} testID="age-gate" keyboardShouldPersistTaps="handled">
      {onBack ? <ScreenHeader title={t('legal.age.title')} onBack={onBack} /> : <Logo size={1.1} />}
      <Card style={styles.card}>
        {!onBack && <Text style={[styles.title, fontFor(t('legal.age.title'), fonts.display)]}>{t('legal.age.title')}</Text>}
        <P style={{ fontSize: 15, lineHeight: 21 }}>{t('legal.age.body', { age: AGE_LIMIT })}</P>
        <View style={styles.row}>
          <TextInput
            testID="age-year"
            accessibilityLabel={t('legal.age.body', { age: AGE_LIMIT })}
            value={year}
            onChangeText={(v) => {
              setYear(v.replace(/\D/g, '').slice(0, 4));
              setInvalid(false);
            }}
            onSubmitEditing={submit}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={4}
            placeholder={t('legal.age.placeholder')}
            placeholderTextColor="#9AA0BF"
            style={styles.input}
          />
          <Button testID="age-continue" title={t('legal.age.continue')} onPress={submit} disabled={year.length !== 4} />
        </View>
        {invalid && <P style={{ color: colors.dangerText, fontSize: 13 }}>{t('legal.age.invalid')}</P>}
        <P dim style={{ fontSize: 12 }}>
          {t('legal.age.note')}
        </P>
        <P dim style={{ fontSize: 12 }}>
          {t('legal.agree')}
        </P>
        <LegalLinks />
      </Card>
    </ScrollView>
  );
}

export function AgeBlocked({ onBack }: { onBack?: () => void }) {
  const { t } = useT();
  const gate = useAgeGate();
  const from = gate.record ? allowedFromYear(gate.record.birthYear) : new Date().getFullYear() + 1;
  return (
    <ScrollView contentContainerStyle={styles.wrap} testID="age-blocked">
      {onBack ? <ScreenHeader title={t('legal.age.blockedTitle')} onBack={onBack} /> : <Logo size={1.1} />}
      <Card style={styles.card}>
        <View style={{ alignSelf: 'center' }}>
          <Icon name="heart" size={40} />
        </View>
        {!onBack && <Text style={[styles.title, fontFor(t('legal.age.blockedTitle'), fonts.display)]}>{t('legal.age.blockedTitle')}</Text>}
        <P style={{ fontSize: 15, lineHeight: 21, textAlign: 'center' }}>{t('legal.age.blockedBody', { age: AGE_LIMIT, year: from })}</P>
        <LegalLinks />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, padding: space.lg, gap: space.lg, alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 480, gap: space.md, alignItems: 'stretch' },
  title: { fontFamily: fonts.display, color: colors.ink, fontSize: 26, textAlign: 'center' },
  row: { gap: 10, alignItems: 'stretch' },
  input: { backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 22, letterSpacing: 4, fontFamily: fonts.display, textAlign: 'center', minHeight: 48 },
});
