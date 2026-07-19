import Markdown from 'react-native-markdown-display';
import tokens from '../../tailwind-colors';

const styles = {
  body: {
    color: tokens.dark.foreground,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 0,
    marginBottom: 4,
  },
  heading1: {
    color: tokens.dark.foreground,
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 30,
    marginTop: 12,
    marginBottom: 8,
  },
  heading2: {
    color: tokens.dark.foreground,
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 26,
    marginTop: 10,
    marginBottom: 6,
  },
  heading3: {
    color: tokens.dark.foreground,
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 23,
    marginTop: 8,
    marginBottom: 4,
  },
  paragraph: { marginTop: 0, marginBottom: 8 },
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
    marginVertical: 6,
  },
  code_block: {
    backgroundColor: tokens.dark.card,
    borderColor: tokens.dark.border,
    fontFamily: 'Menlo',
    fontSize: 12,
    lineHeight: 18,
  },
  link: { color: tokens.dark.ring },
  bullet_list_icon: { color: tokens.dark['muted-foreground'] },
  blockquote: {
    backgroundColor: tokens.dark.card,
    borderLeftColor: tokens.dark.border,
    borderLeftWidth: 2,
    paddingLeft: 10,
  },
} as const;

export function MarkdownText({ text }: { text: string }) {
  return <Markdown style={styles}>{text}</Markdown>;
}
