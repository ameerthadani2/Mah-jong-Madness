/**
 * A number in the rule editor at its limits: the button that would pass a limit is disabled, so a screen reader says
 * so and a press does nothing.
 */
import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Stepper } from './Ui';

describe('a stepper', () => {
  it('disables − at its least value and + at its greatest, and keeps both on in between', async () => {
    const onChange = jest.fn();
    const stepper = (value: number) => <Stepper label="Starting points" value={value} onChange={onChange} step={100} min={100} max={500} />;
    await render(stepper(100));
    expect(screen.getByRole('button', { name: 'Starting points −' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Starting points +' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Starting points −' }));
    expect(onChange).not.toHaveBeenCalled();
    await screen.rerender(stepper(500));
    expect(screen.getByRole('button', { name: 'Starting points +' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Starting points −' })).toBeEnabled();
    await screen.rerender(stepper(300));
    expect(screen.getByRole('button', { name: 'Starting points +' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Starting points −' })).toBeEnabled();
  });
});
