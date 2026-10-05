import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatWait,
  normalize,
  parseFilename,
  parseIsoDuration,
  parseYouTubeId,
} from '../src/shared/text.ts';

describe('parseFilename', () => {
  it.each([
    ['SC8125-01 - Adele - Hello', { discId: 'SC8125-01', artist: 'Adele', title: 'Hello' }],
    ['Journey - Don\'t Stop Believin\'', { artist: 'Journey', title: "Don't Stop Believin'" }],
    ['Blink-182 - All The Small Things', { artist: 'Blink-182', title: 'All The Small Things' }],
    ['SF001-07 - Queen - Bohemian Rhapsody (Karaoke Version)', { discId: 'SF001-07', artist: 'Queen', title: 'Bohemian Rhapsody' }],
    ['ZM-1234 - Toto - Africa', { discId: 'ZM-1234', artist: 'Toto', title: 'Africa' }],
    ['Lizzo_-_Good_As_Hell', { artist: 'Lizzo', title: 'Good As Hell' }],
    ['AC-DC - Back In Black', { artist: 'AC-DC', title: 'Back In Black' }],
    ['Just A Title', { artist: '', title: 'Just A Title' }],
    ['PHM1203-11 - Hello', { discId: 'PHM1203-11', artist: '', title: 'Hello' }],
  ])('%s', (name, expected) => {
    expect(parseFilename(name)).toEqual({ discId: undefined, ...expected });
  });

  it('honours title-first libraries', () => {
    expect(parseFilename('SC8125-01 - Hello - Adele', 'title-artist')).toEqual({ discId: 'SC8125-01', artist: 'Adele', title: 'Hello' });
  });
});

describe('parseYouTubeId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'dQw4w9WgXcQ'],
    ['youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://vimeo.com/123', null],
    ['adele hello', null],
  ])('%s', (input, id) => {
    expect(parseYouTubeId(input)).toBe(id);
  });
});

describe('formatting', () => {
  it('normalizes for search', () => {
    expect(normalize("  Beyoncé & Jay-Z — Crazy in Love! ")).toBe('beyonce and jay z crazy in love');
    expect(normalize("Don't Stop")).toBe('dont stop');
  });

  it('formats durations and waits', () => {
    expect(formatDuration(225)).toBe('3:45');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(undefined)).toBe('–:––');
    expect(formatWait(20)).toBe('now');
    expect(formatWait(600)).toBe('~10 min');
    expect(formatWait(4200)).toBe('~1 hr 10 min');
  });

  it('parses ISO-8601 durations', () => {
    expect(parseIsoDuration('PT4M13S')).toBe(253);
    expect(parseIsoDuration('PT1H2M')).toBe(3720);
    expect(parseIsoDuration('PT45S')).toBe(45);
  });
});
