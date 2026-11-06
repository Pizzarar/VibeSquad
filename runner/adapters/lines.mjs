// Split a stream into lines without buffering the whole output.
export function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}
