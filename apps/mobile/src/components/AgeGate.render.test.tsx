import { beforeEach, describe, expect, it } from '@jest/globals';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AgeGate } from './AgeGate';
import { resetAgeGateForTests } from '../legal/useAgeGate';
import { FakeProviders } from '../test/providers';
import { consent } from '../telemetry';

const THIS_YEAR = new Date().getFullYear();

beforeEach(async () => {
  // A fresh install: nothing answered yet.
  await AsyncStorage.clear();
  resetAgeGateForTests();
});

async function answer(year: string) {
  await render(
    <FakeProviders>
      <AgeGate />
    </FakeProviders>,
  );
  await fireEvent.changeText(await screen.findByLabelText('What year were you born?'), year);
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
}

describe('the age gate', () => {
  it('asks for a birth year before anything else', async () => {
    await render(
      <FakeProviders>
        <AgeGate />
      </FakeProviders>,
    );
    expect(await screen.findByText('Before you play')).toBeOnTheScreen();
    expect(screen.getByLabelText('What year were you born?')).toBeOnTheScreen();
    // Nothing to send until four digits are in.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('turns a player under 18 away, and says from which year they are welcome', async () => {
    const born = THIS_YEAR - 12;
    await answer(String(born));
    expect(await screen.findByText('Sorry, not yet')).toBeOnTheScreen();
    expect(screen.getByText(`This game includes simulated gambling and is for players aged 18 and over, so it is not available to you yet. You are welcome back from 1 January ${born + 19}.`)).toBeOnTheScreen();
    // The answer is kept, so the gate cannot be asked again with another year.
    expect(JSON.parse((await AsyncStorage.getItem('mjm.age'))!).birthYear).toBe(born);
  });

  it('lets an adult through, and keeps only the year', async () => {
    await answer('1990');
    expect(screen.queryByText('Sorry, not yet')).toBeNull();
    expect(JSON.parse((await AsyncStorage.getItem('mjm.age'))!)).toMatchObject({ birthYear: 1990 });
  });

  it("judges the consent question by the gate's own rule at the boundary year", async () => {
    // Born 18 years before this year: the gate turns them away (they may still be 17), and the
    // consent question must treat them as a minor too (analytics off by default).
    const born = THIS_YEAR - 18;
    await answer(String(born));
    expect(await screen.findByText('Sorry, not yet')).toBeOnTheScreen();
    expect(consent.current).toMatchObject({ given: true, minor: true });
  });

  it('treats the first year the gate lets through as an adult for the consent question', async () => {
    await answer(String(THIS_YEAR - 19));
    expect(screen.queryByText('Sorry, not yet')).toBeNull();
    expect(consent.current).toMatchObject({ given: true, minor: false });
  });

  it('asks again for a year that cannot be a birth year', async () => {
    await answer(String(THIS_YEAR + 1));
    expect(await screen.findByText('Enter your birth year as four digits, for example 1990.')).toBeOnTheScreen();
    expect(await AsyncStorage.getItem('mjm.age')).toBeNull();
  });
});
