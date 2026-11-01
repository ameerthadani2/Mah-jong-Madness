/**
 * Structured curriculum for Learn mode. Content is data so the app can render
 * it, track progress, and the coach can link scoring items back to lessons.
 */
export interface LessonStep {
  title: string;
  body: string;
  /** Optional compact hand to display, e.g. "123m 456p 789s EEE CC". */
  hand?: string;
  /** Optional quiz: which discard is best? Answer as a tile code. */
  quiz?: { prompt: string; hand: string; answer: string; explanation: string };
}

export interface Lesson {
  id: string;
  title: string;
  titleZh: string;
  minutes: number;
  summary: string;
  steps: LessonStep[];
}

export const LESSONS: Lesson[] = [
  {
    id: 'tiles',
    title: 'The tiles',
    titleZh: '認識牌',
    minutes: 3,
    summary: 'Learn the 144 tiles: three suits, winds, dragons and the eight bonus tiles.',
    steps: [
      { title: 'Suits', body: 'Three suits run 1–9: 萬 (characters), 筒 (dots) and 條 (bamboo). Each tile has four copies.', hand: '123456789m' },
      { title: 'Honors', body: 'Winds 東南西北 and dragons 中發白 have no sequence; they only make pairs, pongs and kongs.', hand: 'ESWN CFB' },
      { title: 'Bonus tiles', body: 'Flowers 梅蘭竹菊 and seasons 春夏秋冬 are not part of your hand. When you draw one it is set aside and you draw a replacement from the back of the wall. They score 台 if they match your seat.', hand: 'f1 f2 f3 f4' },
    ],
  },
  {
    id: 'win',
    title: 'How to win',
    titleZh: '怎麼胡牌',
    minutes: 4,
    summary: 'Taiwanese Mahjong uses 16 tiles. A winning hand is five sets plus one pair.',
    steps: [
      { title: 'Five sets + a pair', body: 'A set is a chow (三張連號 123) or a pong (三張相同). You hold 16 tiles and win with a 17th that completes 5 sets + 1 pair.', hand: '123m 456m 789p 234s EEE CC' },
      { title: 'Draw and discard', body: 'On your turn draw one tile from the wall, then discard one. Your hand is always 16 tiles between turns.' },
      { title: 'Self-draw vs discard', body: 'Winning on your own draw is 自摸 (everyone pays). Winning on someone’s discard is 放槍 (only they pay).' },
      {
        title: 'Spot the wait',
        body: 'With 16 tiles you are 聽牌 (ready) when one more tile completes the hand.',
        quiz: { prompt: 'Which tile completes this hand?', hand: '123m 456m 789p 234s EEE C', answer: 'C', explanation: 'Five sets are complete; the lone 中 needs its partner to form the pair (單騎).' },
      },
    ],
  },
  {
    id: 'calls',
    title: 'Chi, Pong, Kong',
    titleZh: '吃碰槓',
    minutes: 5,
    summary: 'Use other players’ discards to build sets, and understand the priority order.',
    steps: [
      { title: 'Chi (吃)', body: 'Only the discard from the player on your left (上家) can be taken for a chow. The set is laid face up.' },
      { title: 'Pong (碰)', body: 'Any player’s discard can be taken when you hold two of the same tile. Pong beats chi if both are called.' },
      { title: 'Kong (槓)', body: 'Four of a kind. 暗槓 from hand, 明槓 from a discard, or 加槓 by adding to your pong. Every kong draws a replacement tile from the back of the wall.' },
      { title: 'Priority', body: 'Win (胡) beats pong/kong, which beat chi. If two players can win on the same discard, the one next in turn order wins.' },
      { title: 'The cost of calling', body: 'Exposing sets gives up 門清 (concealed hand) and shows opponents what you need. Call when it clearly moves you closer to ready.' },
    ],
  },
  {
    id: 'scoring',
    title: 'Counting 台',
    titleZh: '算台',
    minutes: 6,
    summary: 'Every hand pays 底 + 台 × points. Learn the common 台 and how dealer bonuses work.',
    steps: [
      { title: 'Base and 台', body: 'A hand is worth 底 (base) plus 台 × per-台 value. With 底100/台20, a 3-台 hand is 160 points per payer.' },
      { title: 'Common 1 台', body: '自摸 self-draw, 門清 concealed, 獨聽 single wait, 正花 seat flower, 圈風/門風 wind pong, each dragon pong 中發白, 槓上開花, 海底撈月, 搶槓.' },
      { title: '2–4 台', body: '平胡 all chows (2), 三暗刻 (2), 花槓 four of a bonus set (2), 全求人 (2), 門清自摸 (3), 碰碰胡 all pongs (4), 混一色 half flush (4), 小三元 (4), 四暗刻 (5).' },
      { title: 'Big hands', body: '清一色 full flush (8), 大三元 (8), 小四喜 (8), 五暗刻 (8), 八仙過海 all 8 bonus tiles (8), 字一色 all honors (16), 大四喜 (16), 天胡/地胡 (16).' },
      { title: 'Dealer', body: 'The dealer (莊) adds 1 台 whenever they win or pay. Each consecutive dealer hand adds 連莊拉莊 (2 台 per streak).' },
    ],
  },
  {
    id: 'efficiency',
    title: 'Tile efficiency',
    titleZh: '牌效率',
    minutes: 6,
    summary: 'Discard the tiles with the fewest ways to improve. The coach shows this as shanten and acceptance.',
    steps: [
      { title: 'Shanten', body: '向聽數 counts how many exchanges you are from ready. The coach shows it every turn; aim to lower it each discard.' },
      { title: 'Keep open shapes', body: 'Two-sided partials like 45 (waiting 3 or 6) beat edge 12 or middle 13 shapes. Lone honors and terminals are usually the first to go.' },
      {
        title: 'Practice',
        body: 'Pick the discard that keeps the most useful tiles.',
        quiz: { prompt: 'Best discard?', hand: '234m 567m 45p 789p 33s 678s N', answer: 'N', explanation: 'The North wind is an isolated honor with no partner. Everything else is part of a set, a pair or a two-sided wait.' },
      },
      {
        title: 'Practice 2',
        body: 'Edge shapes are weaker than open shapes.',
        quiz: { prompt: 'Best discard?', hand: '12m 345m 456p 678p 999s 56s EE', answer: '1m', explanation: 'The 12m edge wait only completes with 3m. Discarding 1m leaves 2m to pair with something more flexible, while 56s stays as a two-sided wait.' },
      },
    ],
  },
  {
    id: 'defence',
    title: 'Defence',
    titleZh: '防守',
    minutes: 4,
    summary: 'Avoid 放槍 when an opponent is clearly ready.',
    steps: [
      { title: 'Read the table', body: 'Four exposed sets means a player only needs one tile. Treat their remaining wait as live.' },
      { title: 'Safe tiles', body: 'Tiles a ready player has already discarded cannot usually be their wait shape in practice; copies already visible four times are completely safe.' },
      { title: 'Fold when behind', body: 'If you are 3+ shanten and someone looks ready, prioritise safe discards over speed. Losing 1 台 is better than paying 8.' },
    ],
  },
];
