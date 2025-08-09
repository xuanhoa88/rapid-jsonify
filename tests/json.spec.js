const fs = require('fs');
const path = require('path');
const { readJSONFile, writeJSONFile } = require('../src');

const TEST_DIR = path.resolve(__dirname, 'tmp');
const TEST_FILE = path.join(TEST_DIR, 'test.json');
const NON_EXISTENT_FILE = path.join(TEST_DIR, 'nonexistent.json');
const TMP_TEST_FILE = TEST_FILE + '.tmp';

beforeAll(async () => {
  try {
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
  } catch {
    // Ignore errors if the directory already exists
  }
});

afterAll(async () => {
  try {
    await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore errors if the directory does not exist
  }

  try {
    await fs.promises.unlink(TEST_FILE);
  } catch {
    // Ignore errors if the file does not exist
  }

  try {
    await fs.promises.unlink(TMP_TEST_FILE);
  } catch {
    // Ignore errors if the temp file does not exist
  }
});

afterEach(async () => {
  jest.resetModules();

  try {
    await fs.promises.unlink(TEST_FILE);
  } catch {
    // Ignore errors if the file does not exist
  }

  try {
    await fs.promises.unlink(TMP_TEST_FILE);
  } catch {
    // Ignore errors if the temp file does not exist
  }
});

describe('readJSONFile', () => {
  test('reads file with nested jsonPathPattern (users.*.name)', async () => {
    const data = {
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    };
    await fs.promises.writeFile(TEST_FILE, JSON.stringify(data));

    const result = await readJSONFile(TEST_FILE, { jsonPathPattern: 'users.*.name' });
    expect(result.parsed).toEqual(expect.arrayContaining(['Alice', 'Bob']));
  });

  test('reads file with jsonPathPattern as array', async () => {
    const data = {
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    };
    await fs.promises.writeFile(TEST_FILE, JSON.stringify(data));

    const result = await readJSONFile(TEST_FILE, { jsonPathPattern: ['users', '*', 'id'] });
    expect(result.parsed).toEqual(expect.arrayContaining([1, 2]));
  });

  test('returns empty array if pattern matches nothing', async () => {
    const data = { foo: [{ bar: 1 }] };
    await fs.promises.writeFile(TEST_FILE, JSON.stringify(data));
    const result = await readJSONFile(TEST_FILE, { jsonPathPattern: 'notfound.*' });
    expect(result.parsed).toEqual([]);
  });
  test('returns error for invalid TEST_FILE types', async () => {
    const result1 = await readJSONFile('');
    expect(result1.error).toBeInstanceOf(Error);

    const result2 = await readJSONFile(null);
    expect(result2.error).toBeInstanceOf(Error);
  });

  test('returns error if file does not exist', async () => {
    const result = await readJSONFile(NON_EXISTENT_FILE);
    expect(result.isFileAccessible).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  test('successfully reads a small JSON file', async () => {
    const data = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await fs.promises.writeFile(TEST_FILE, JSON.stringify(data));

    const result = await readJSONFile(TEST_FILE);
    expect(result.isFileAccessible).toBe(true);
    expect(result.error).toBeNull();
    expect(result.parsed).toEqual(data);
  });

  test('reads with raw data included', async () => {
    const data = [{ id: 12345 }];
    await fs.promises.writeFile(TEST_FILE, JSON.stringify(data));

    const result = await readJSONFile(TEST_FILE, { includeRawData: true });
    expect(result.isFileAccessible).toBe(true);
    expect(result.raw).toBe(JSON.stringify(data));
  });

  test('returns error for empty file', async () => {
    await fs.promises.writeFile(TEST_FILE, '');
    const originalError = console.error;
    console.error = jest.fn();
    const result = await readJSONFile(TEST_FILE);
    console.error = originalError;
    expect(result.error).toBeInstanceOf(Error);
  });

  test('reads file with jsonPathPattern (basic)', async () => {
    const data = {
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    };
    await fs.promises.writeFile(TEST_FILE, JSON.stringify(data));

    const result = await readJSONFile(TEST_FILE, { jsonPathPattern: 'users.*' });
    // Because your stream parser is custom, expect at least both user objects to be parsed
    expect(result.parsed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
      ])
    );
  });
});

describe('writeJSONFile', () => {
  test('writes JSON with custom replacer', async () => {
    const data = [
      { id: 1, secret: 'hide' },
      { id: 2, secret: 'hide' },
    ];
    const replacer = (key, value) => (key === 'secret' ? undefined : value);
    const result = await writeJSONFile(TEST_FILE, data, { replacer });
    expect(result.success).toBe(true);
    const fileContents = await fs.promises.readFile(TEST_FILE, 'utf8');
    expect(fileContents).not.toMatch(/"secret"/);
  });

  test('writes and reads BigInt and large numbers', async () => {
    const data = [
      { id: 1, big: BigInt('9007199254740993') },
      { id: 2, big: BigInt('9007199254740994') },
      { id: 3, big: '9007199254740995' },
    ];
    const writeResult = await writeJSONFile(TEST_FILE, data);
    expect(writeResult.success).toBe(true);
    const readResult = await readJSONFile(TEST_FILE);
    expect(readResult.error).toBeNull();
    expect(readResult.parsed.length).toBe(3);
    expect(readResult.parsed[0].big.toString()).toBe('9007199254740993');
    expect(readResult.parsed[1].big.toString()).toBe('9007199254740994');
    expect(readResult.parsed[2].big).toBe(BigInt('9007199254740995'));
  });
  test('returns error for invalid file path', async () => {
    const result = await writeJSONFile('', [{ id: 1 }]);
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  test('returns error for invalid chunkSize or batchSize', async () => {
    let result = await writeJSONFile(TEST_FILE, [{ id: 1 }], { chunkSize: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);

    result = await writeJSONFile(TEST_FILE, [{ id: 1 }], { batchSize: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  test('successfully writes JSON array to file', async () => {
    const data = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = await writeJSONFile(TEST_FILE, data, { pretty: true });
    expect(result.success).toBe(true);

    const fileContents = await fs.promises.readFile(TEST_FILE, 'utf8');
    expect(fileContents).toMatch(/^\[\n/);
    expect(fileContents).toMatch(/"id": 1/);
  });

  test('calls onProgress callback during writing', async () => {
    const data = [];
    for (let i = 0; i < 50; i++) {
      data.push({ id: i });
    }

    let progressCalls = 0;
    const onProgress = jest.fn(() => {
      progressCalls++;
    });

    const result = await writeJSONFile(TEST_FILE, data, {
      batchSize: 10,
      chunkSize: 5,
      onProgress,
    });
    expect(result.success).toBe(true);
    expect(progressCalls).toBeGreaterThan(0);
  });

  test('writes and reads large array without crashing', async () => {
    const data = [];
    for (let i = 0; i < 5000; i++) {
      data.push({ id: i, big: BigInt(2 ** 53 + i).toString() });
    }

    const writeResult = await writeJSONFile(TEST_FILE, data, { pretty: false, batchSize: 1000 });
    expect(writeResult.success).toBe(true);

    const readResult = await readJSONFile(TEST_FILE);
    expect(readResult.error).toBeNull();
    expect(readResult.parsed.length).toBe(5000);
    expect(readResult.parsed[0]).toHaveProperty('id', 0);
  });

  test('should write file atomically and remove temp file on success', async () => {
    const data = [{ a: 1 }, { b: 2 }];
    const result = await writeJSONFile(TEST_FILE, data);
    expect(result.success).toBe(true);
    expect(fs.existsSync(TEST_FILE)).toBe(true);
    expect(fs.existsSync(TMP_TEST_FILE)).toBe(false);
    const content = JSON.parse(fs.readFileSync(TEST_FILE, 'utf8'));
    expect(content).toEqual(data);
  });

  test('should leave original file unchanged if rename fails', async () => {
    // Simulate rename failure by making temp file a directory
    const data = [{ x: 1 }];
    fs.mkdirSync(TMP_TEST_FILE);
    const result = await writeJSONFile(TEST_FILE, data);
    expect(result.success).toBe(false);
    expect(fs.existsSync(TEST_FILE)).toBe(false);
    expect(fs.existsSync(TMP_TEST_FILE)).toBe(false); // should be cleaned up
  });
});
