const COMMANDS = ['#lysel', '#Lysel'];

export function isBuiltinCommand(text: string | undefined): boolean {
  return text !== undefined && COMMANDS.includes(text);
}
