import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Toggle } from './Ui';

describe('the shared Toggle', () => {
  it('is a switch, named by its label, that says it is off', async () => {
    await render(<Toggle label="Sound effects" value={false} onChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Sound effects' })).not.toBeChecked();
  });

  it('says it is on when it is', async () => {
    await render(<Toggle label="Sound effects" value onChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Sound effects' })).toBeChecked();
  });

  it('asks for the other value when pressed', async () => {
    const onChange = jest.fn();
    await render(<Toggle label="Haptics" value onChange={onChange} />);
    await fireEvent.press(screen.getByRole('switch', { name: 'Haptics' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
