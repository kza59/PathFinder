export function fileName(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}
