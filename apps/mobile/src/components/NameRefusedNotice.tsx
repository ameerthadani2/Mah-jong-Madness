/**
 * Shown while the saved name is one the game server refused (its name check; src/logic/profile.ts
 * `isNameRefused`): says so in the player's language and points to where the name is changed
 * (Settings, Profile). Renders nothing otherwise, so screens can place it unconditionally.
 */
import React from 'react';
import { cleanText } from '@mjm/net';
import { useApp } from '../app-state';
import { useT } from '../i18n';
import { isNameRefused } from '../logic/profile';
import { Button, Card, P, Row } from './Ui';
import { Icon } from './Icons';

export function NameRefusedNotice() {
  const app = useApp();
  const { t } = useT();
  if (!isNameRefused(app.profile)) return null;
  return (
    <Card tone="gold" testID="name-refused">
      <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <Icon name="warning" size={24} />
        <P style={{ flex: 1, minWidth: 180 }}>{t('settings.nameRefused.notice', { name: cleanText(app.profile.name, 24) })}</P>
        <Button small testID="name-refused-change" title={t('settings.nameRefused.change')} onPress={() => app.go({ name: 'settings' })} />
      </Row>
    </Card>
  );
}
