/**
 * "Report player": a bottom sheet with a reason picker and an optional note, sent with
 * POST /api/reports (src/legal/reports.ts builds the body). Self-contained, so a table or a
 * club screen only renders it:
 *
 *   <ReportPlayerSheet visible={!!target} target={target} onClose={() => setTarget(null)} />
 *
 * with `target = { userId, name, roomCode?, clubCode? }` for a seated human (never a bot).
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { clubsApi, httpBase } from '../api/clubs';
import { friendlyError } from '../logic/errors';
import { useT } from '../i18n';
import { buildReport, REPORT_NOTE_MAX, REPORT_REASONS, type ReportReason, type ReportTarget } from '../legal/reports';
import { colors, fonts, space } from '../theme';
import { Button, Card, Chip, H2, P, Pill, Row } from './Ui';

export function ReportPlayerSheet({ visible, target, onClose }: { visible: boolean; target: ReportTarget | null; onClose: () => void }) {
  const app = useApp();
  const auth = useAuth();
  const { t } = useT();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  // A fresh form for every player reported.
  useEffect(() => {
    setReason(null);
    setNote('');
    setState('idle');
    setError(null);
  }, [target?.userId, visible]);

  const payload = target ? buildReport(target, reason, note, auth.user?.id ?? null) : null;
  const send = async () => {
    if (!payload) return;
    setState('sending');
    setError(null);
    try {
      await auth.client.ensureSession();
      await clubsApi.report({ base: httpBase(app.signalUrl), auth: auth.client }, payload);
      setState('sent');
    } catch (e) {
      setError(friendlyError(e, t));
      setState('idle');
    }
  };

  return (
    <Modal visible={visible && !!target} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('legal.report.cancel')} />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <Card style={styles.sheet} testID="report-sheet">
          <ScrollView contentContainerStyle={{ gap: space.md }} keyboardShouldPersistTaps="handled">
            <H2>{t('legal.report.title', { name: target?.name ?? '' })}</H2>
            {state === 'sent' ? (
              <>
                <Pill tone="ok" icon="check" text={t('legal.report.sent')} />
                <Button testID="report-done" title={t('legal.report.done')} onPress={onClose} />
              </>
            ) : (
              <>
                <P dim style={{ fontSize: 13, lineHeight: 18 }}>
                  {t('legal.report.body')}
                </P>
                <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
                  {REPORT_REASONS.map((r) => (
                    <Chip key={r} label={t(`legal.report.reasons.${r}`)} selected={reason === r} onPress={() => setReason(r)} />
                  ))}
                </Row>
                <TextInput
                  testID="report-note"
                  value={note}
                  onChangeText={setNote}
                  placeholder={t('legal.report.notePlaceholder')}
                  placeholderTextColor="#9AA0BF"
                  multiline
                  maxLength={REPORT_NOTE_MAX}
                  style={styles.input}
                />
                {error && <Pill tone="danger" icon="warning" text={error} />}
                <Row>
                  <Button testID="report-send" title={state === 'sending' ? t('legal.report.sending') : t('legal.report.send')} onPress={() => void send()} disabled={!payload || state === 'sending'} />
                  <Button kind="ghost" title={t('legal.report.cancel')} onPress={onClose} />
                </Row>
              </>
            )}
          </ScrollView>
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,20,47,0.55)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', padding: space.md },
  sheet: { width: '100%', maxWidth: 560, maxHeight: '85%' },
  input: { minHeight: 72, backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontFamily: fonts.body, textAlignVertical: 'top' },
});
