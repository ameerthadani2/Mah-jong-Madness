import { afterEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { AvatarGallery } from './AvatarGallery';
import { AVATAR_IDS, avatarName } from '../components/Avatars';
import { setLocalePreference } from '../i18n';

afterEach(() => {
  setLocalePreference('auto');
});

describe('the avatar gallery (web only, #avatars)', () => {
  it('shows every portrait with its name and id, then the seat plates in their table states, then the small sizes', async () => {
    await render(<AvatarGallery />);
    expect(screen.getAllByText(/^(Portraits|Seat plates on the felt|Small sizes \(lobby lists, results\))$/).map((n) => n.props.children)).toEqual(['Portraits', 'Seat plates on the felt', 'Small sizes (lobby lists, results)']);
    // One label per portrait, in the order the app lists them.
    const labels = screen.getAllByText(/ · /).map((n) => [n.props.children].flat().join(''));
    expect(labels).toEqual(AVATAR_IDS.map((id) => `${avatarName(id)} · ${id}`));
    // The plates go round the four winds and mark one dealer, as seats at a table would.
    expect(screen.getAllByText('莊')).toHaveLength(1);
    for (const wind of ['東', '南', '西', '北']) expect(screen.getAllByText(wind)).toHaveLength(AVATAR_IDS.length / 4);
  });

  it('names its sections in Traditional Chinese', async () => {
    setLocalePreference('zh-TW');
    await render(<AvatarGallery />);
    expect(screen.getByText('頭像')).toBeOnTheScreen();
    expect(screen.getByText('牌桌上的座位牌')).toBeOnTheScreen();
    expect(screen.getByText('小尺寸（房間列表、結果）')).toBeOnTheScreen();
  });
});
