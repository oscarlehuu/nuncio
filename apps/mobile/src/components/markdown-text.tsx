import Markdown from 'react-native-markdown-display';
import tokens from '../../tailwind-colors';

const styles = {
  body: { color: tokens.dark.foreground, fontSize: 14, lineHeight: 21 },
  code_inline: {
    backgroundColor: tokens.dark.muted,
    color: tokens.dark.foreground,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: 'Menlo',
    fontSize: 13,
  },
  fence: {
    backgroundColor: tokens.dark.card,
    borderColor: tokens.dark.border,
    borderRadius: 8,
    padding: 10,
  },
  code_block: {
    backgroundColor: tokens.dark.card,
    borderColor: tokens.dark.border,
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  link: { color: tokens.dark.ring },
  bullet_list_icon: { color: tokens.dark['muted-foreground'] },
  blockquote: {
    backgroundColor: tokens.dark.card,
    borderLeftColor: tokens.dark.border,
  },
} as const;

export function MarkdownText({ text }: { text: string }) {
  return <Markdown style={styles}>{text}</Markdown>;
}
