import { isTranscriptCodePathLike } from './transcript-link-target';

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const SOURCE_PATH_RE =
  /(^|[\s([{"'])(\.{0,2}\/?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+(?::\d+(?::\d+)?)?(?:#L?\d+)?)/g;

export function remarkCodePathLinks() {
  return (tree: MarkdownNode) => {
    transformChildren(tree, false);
  };
}

function transformChildren(node: MarkdownNode, insideLink: boolean) {
  if (!node.children) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'text' && !insideLink) {
      const replacement = linkifyText(child.value ?? '');
      if (replacement.length > 1 || replacement[0] !== child) {
        node.children.splice(i, 1, ...replacement);
        i += replacement.length - 1;
      }
      continue;
    }
    transformChildren(child, insideLink || child.type === 'link');
  }
}

function linkifyText(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let last = 0;
  SOURCE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SOURCE_PATH_RE.exec(value)) !== null) {
    const prefix = match[1] ?? '';
    const candidate = match[2] ?? '';
    const candidateIndex = match.index + prefix.length;
    if (!isTranscriptCodePathLike(candidate)) continue;

    if (candidateIndex > last) {
      nodes.push({ type: 'text', value: value.slice(last, candidateIndex) });
    }
    nodes.push({
      type: 'link',
      url: candidate,
      children: [{ type: 'text', value: candidate }],
    });
    last = candidateIndex + candidate.length;
  }

  if (last === 0) return [{ type: 'text', value }];
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
}
