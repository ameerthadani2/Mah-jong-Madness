/**
 * Settings → Sound: the master sound switch (Settings.sound) and the voice for table calls, which lives in
 * its own storage key (src/audio/voicePref.ts). A voice set whose lines are not recorded yet still works:
 * the calls show as banners, and the note under the chips says so.
 */
import React from 'react';
import { View } from 'react-native';
import { useApp } from '../app-state';
import { sfx, useVoicePreference, voicePrefs, VOICE_PREFERENCES, type VoicePreference } from '../audio';
import { CALL_KINDS } from '../audio/cues';
import { useT } from '../i18n';
import { Button, Card, Chip, H2, P, Row, Toggle } from './Ui';

export function SoundSettings() {
  const app = useApp();
  const { t } = useT();
  const voice = useVoicePreference();
  const { settings } = app;
  const missing = voice !== 'off' && CALL_KINDS.some((c) => !sfx.hasVoice(c, voice));
  const pick = (v: VoicePreference) => {
    void voicePrefs.set(v);
    // Preview the choice straight away (the shared engine picks the new voice up on the next render too).
    sfx.setOptions({ sound: settings.sound, voice: v });
    sfx.call('pong');
  };
  return (
    <Card testID="sound-settings">
      <H2>{t('audio.title')}</H2>
      <Toggle label={t('audio.sound')} value={settings.sound} onChange={(sound) => app.setSettings({ ...settings, sound })} />
      <View style={{ gap: 6, opacity: settings.sound ? 1 : 0.5 }}>
        <P dim>{t('audio.voiceLabel')}</P>
        <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
          {VOICE_PREFERENCES.map((v) => (
            <Chip key={v} label={t(`audio.voice.${v}`)} selected={voice === v} onPress={() => pick(v)} />
          ))}
        </Row>
        {missing && <P dim>{t('audio.voiceMissing')}</P>}
        <Row>
          <Button small kind="ghost" icon="play" title={t('audio.test')} disabled={!settings.sound} onPress={() => (voice === 'off' || !sfx.call('hu') ? sfx.sfx('discard') : true)} />
        </Row>
      </View>
    </Card>
  );
}
