/**
 * Settings → Display: tile size and text size, each Normal / Large / Extra large (src/display). The choice is
 * saved under its own storage key and shows straight away in the preview row.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { useDisplayScale } from '../display/DisplayScale';
import { SCALE_STEPS, TEXT_SCALES, TILE_SCALES } from '../display/scale';
import { Tile, scaledTile } from './Tile';
import { Card, Chip, H2, P, Row } from './Ui';

const PREVIEW = [0, 9, 18, 27, 31] as const;

export function DisplaySettings() {
  const { t } = useT();
  const d = useDisplayScale();
  return (
    <Card testID="display-settings">
      <H2>{t('settings.display.title')}</H2>
      <View style={styles.item}>
        <P>{t('settings.display.tiles')}</P>
        <Row style={styles.chips}>
          {TILE_SCALES.map((s, i) => (
            <Chip key={s} label={t(`settings.display.${SCALE_STEPS[i]}`)} selected={d.tileScale === s} onPress={() => d.setTileScale(s)} />
          ))}
        </Row>
        <View style={styles.preview} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {PREVIEW.map((k) => (
            <Tile key={k} kind={k} size={scaledTile('sm', d.tileScale)} />
          ))}
        </View>
        <P dim>{t('settings.display.tilesHelp')}</P>
      </View>
      <View style={styles.item}>
        <P>{t('settings.display.text')}</P>
        <Row style={styles.chips}>
          {TEXT_SCALES.map((s, i) => (
            <Chip key={s} label={t(`settings.display.${SCALE_STEPS[i]}`)} selected={d.textScale === s} onPress={() => d.setTextScale(s)} />
          ))}
        </Row>
        <P>{t('settings.display.sample')}</P>
        <P dim>{t('settings.display.textHelp')}</P>
        {d.osScale > 1 && <P dim>{t('settings.display.osFloor', { pct: Math.round(d.osScale * 100) })}</P>}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  item: { gap: 6 },
  chips: { flexWrap: 'wrap', rowGap: 8 },
  preview: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, rowGap: 4, paddingVertical: 4 },
});
