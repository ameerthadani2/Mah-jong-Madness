/**
 * Developer gallery for avatar art (web only, open the app with #avatars).
 * Shows every portrait large on both backgrounds the app uses, plus the seat
 * plates in their table states, so avatar changes can be reviewed at a glance.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Avatar, AvatarPlate, AVATAR_IDS, avatarName } from '../components/Avatars';
import { useT } from '../i18n';
import { colors } from '../theme';

export function AvatarGallery() {
  const { t } = useT();
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.h}>{t('avatars.gallery.portraits')}</Text>
      <View style={styles.grid}>
        {AVATAR_IDS.map((id) => (
          <View key={id} style={styles.cell}>
            <Avatar id={id} size={150} />
            <Text style={styles.label}>
              {avatarName(id)} · {id}
            </Text>
          </View>
        ))}
      </View>
      <Text style={styles.h}>{t('avatars.gallery.plates')}</Text>
      <View style={[styles.grid, styles.felt]}>
        {AVATAR_IDS.map((id, i) => (
          <AvatarPlate key={id} id={id} size={56} active={i % 4 === 0} timer={i % 4 === 0 ? 0.6 : null} timerUrgent={i === 8} dealer={i === 1} wind={['東', '南', '西', '北'][i % 4]} offline={i === 11} />
        ))}
      </View>
      <Text style={styles.h}>{t('avatars.gallery.small')}</Text>
      <View style={[styles.grid, styles.sky]}>
        {AVATAR_IDS.map((id) => (
          <View key={id} style={{ alignItems: 'center', gap: 4 }}>
            <Avatar id={id} size={40} />
            <Avatar id={id} size={26} />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#173B5C' },
  content: { padding: 16, gap: 14 },
  h: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, padding: 12, borderRadius: 16 },
  cell: { alignItems: 'center', gap: 6 },
  label: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  felt: { backgroundColor: colors.felt },
  sky: { backgroundColor: colors.sky },
});
