# JSON File Utils

Utility library for reading and writing JSON files with support for large files, streaming parsing,
and safe handling of large numeric values (BigInt and unsafe integers) without losing precision.

---

## Features

- **Streaming JSON parsing** with JSONPath-like pattern matching for large files
- **Chunked JSON writing** with progress tracking and atomic writes
- **Safe parsing and stringifying** that preserves large integers as strings to avoid precision loss
- **File locking** using `rapid-mutex` for atomic, concurrent-safe writes
- Automatic directory creation when writing files

---

## Installation

```bash
npm install rapid-jsonify
```

---

## Usage

### Reading JSON files with safe large number handling

```js
import { readJSONFile } from 'rapid-jsonify';

(async () => {
  const result = await readJSONFile('/path/to/file.json', {
    jsonPathPattern: 'sensors.*.readings', // pattern to extract specific nodes
    includeRawData: false,
  });

  if (result.error) {
    console.error('Failed to read JSON:', result.error);
    return;
  }

  // Large numbers in parsed data are preserved as strings if unsafe
  console.log(result.parsed);
})();
```

### Writing JSON files with chunked writing and progress callbacks

```js
import { writeJSONFile } from 'rapid-jsonify';

const bigData = [
  /* large array of objects */
];

await writeJSONFile('/path/to/output.json', bigData, {
  pretty: true,
  chunkSize: 500,
  batchSize: 2000,
  onProgress: ({ percentage }) => console.log(`Progress: ${percentage}%`),
});
```

---

## Large Number Safety

This library **preserves large integers and BigInt values** by:

- Parsing large numeric strings and unsafe numbers as strings to avoid precision loss.
- Stringifying BigInt and unsafe numbers as strings, ensuring no numeric data is lost.
- **Note:** Large numbers beyond JavaScript's safe integer range (`Number.MAX_SAFE_INTEGER`) are stored as strings in parsed output.

---

## API

### `readJSONFile(filePath, options)`

- `filePath` — Path to JSON file
- `options` — Configuration object (see source for full options)
- Returns: `{ parsed: Array, raw: string, isFileAccessible: boolean, error: Error | null }`

### `writeJSONFile(filePath, data, options)`

- `filePath` — Path to write JSON file
- `data` — Array of JSON-serializable objects
- `options` — Configuration object, including `chunkSize`, `batchSize`, `pretty`, `onProgress`
- Returns: `true` if write successful, throws on error

---

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

---

## Acknowledgments

- Built with ❤️ for the JavaScript community.
- Inspired by common challenges in handling adaptive responses.
