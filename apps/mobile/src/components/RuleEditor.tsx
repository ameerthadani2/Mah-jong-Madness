/**
 * Every house rule, grouped (stakes, match length, dealer, dead wall, claims, flowers, 天/地/人胡,
 * speed), with limits from the engine's RULE_LIMITS. A preset sets a baseline; edits after it are
 * kept, and choosing another preset over edits asks first. The parent owns the rules: it saves them
 * (the club's rules tab) or uses them for one table (a variant table).
 */
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { RULE_LIMITS, RULE_PRESETS, SPEED_PRESETS, type GameSpeed, type RulePreset, type RuleSet } from '@mjm/engine';
import { useT } from '../i18n';
import { choosePreset, matchingPreset, presetName, RULE_GROUPS, setRule, speedLabel, type RuleField } from '../logic/rules-text';
import { colors, space } from '../theme';
import { Button, Card, Chip, P, Row, SectionLabel, Stepper, Toggle } from './Ui';

export function RuleEditor({ value, onChange, baseline: initialBaseline }: { value: RuleSet; onChange: (rules: RuleSet) => void; baseline?: RuleSet }) {
  const { t, locale } = useT();
  // The rules the last preset (or the saved rules) set; edits are whatever differs from it.
  const [baseline, setBaseline] = useState<RuleSet>(initialBaseline ?? value);
  const [asking, setAsking] = useState<RulePreset | null>(null);
  const current = matchingPreset(value);

  const pick = (p: RulePreset, force = false) => {
    const choice = choosePreset(value, baseline, p.id, force);
    if (choice.action === 'confirm') return setAsking(p);
    setAsking(null);
    setBaseline(choice.rules);
    onChange(choice.rules);
  };

  const field = (f: RuleField) => {
    const label = t(`clubs.ruleEditor.fields.${f.key}`);
    if (f.kind === 'toggle') return <Toggle key={f.key} label={label} value={value[f.key]} onChange={(v) => onChange(setRule(value, f.key, v))} />;
    if (f.kind === 'speed') {
      return (
        <Row key="speed" style={styles.chips}>
          {(Object.keys(SPEED_PRESETS) as GameSpeed[]).map((sp) => (
            <Chip key={sp} label={t('clubs.rules.speedChip', { label: speedLabel(sp, locale), turn: SPEED_PRESETS[sp].turnSeconds })} selected={value.speed === sp} onPress={() => onChange(setRule(value, 'speed', sp))} />
          ))}
        </Row>
      );
    }
    const [min, max] = RULE_LIMITS[f.key];
    const format = f.key === 'maxTai' ? (v: number) => (v === 0 ? t('clubs.ruleEditor.noCap') : String(v)) : undefined;
    return <Stepper key={f.key} label={label} value={value[f.key]} min={min} max={max} step={f.step} format={format} onChange={(v) => onChange(setRule(value, f.key, v))} />;
  };

  return (
    <View style={styles.wrap}>
      <P dim style={styles.small}>
        {t('clubs.ruleEditor.presets')}
      </P>
      <Row style={styles.chips}>
        {RULE_PRESETS.map((p) => (
          <Chip key={p.id} label={presetName(p, locale)} selected={current === p.id} onPress={() => pick(p)} />
        ))}
      </Row>
      {asking && (
        <Card tone="gold" style={{ gap: 8 }}>
          <P style={styles.small}>{t('clubs.ruleEditor.presetConfirm', { name: presetName(asking, locale) })}</P>
          <Row>
            <Button small kind="danger" title={t('clubs.ruleEditor.presetReplace')} onPress={() => pick(asking, true)} />
            <Button small kind="ghost" title={t('clubs.ruleEditor.keep')} onPress={() => setAsking(null)} />
          </Row>
        </Card>
      )}
      {RULE_GROUPS.map((g) => (
        <View key={g.id} style={styles.group}>
          <SectionLabel>{t(`clubs.ruleEditor.groups.${g.id}`)}</SectionLabel>
          {g.fields.map(field)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  chips: { flexWrap: 'wrap', rowGap: 6 },
  group: { gap: 4, paddingTop: 4, borderTopWidth: 2, borderTopColor: colors.creamDeep },
  small: { fontSize: 12, lineHeight: 17 },
});
