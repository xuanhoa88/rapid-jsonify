const fs = require('fs');
const path = require('path');
const { withMutex } = require('rapid-mutex');
const { Transform, pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

/**
 * Destroy a stream and remove all listeners if possible (cleanup helper).
 * @param {object} stream
 */
const cleanupStream = stream => {
  try {
    if (stream && !stream.destroyed && typeof stream.destroy === 'function') {
      stream.destroy();
    }
    if (stream && typeof stream.removeAllListeners === 'function') {
      stream.removeAllListeners();
    }
  } catch (err) {
    console.error('Error during stream cleanup:', err);
  }
};

/**
 * Custom JSON.parse that preserves large integers as BigInt.
 * Handles integers beyond JavaScript's safe integer range (±2^53-1).
 *
 * @param {string} text - JSON string to parse
 * @param {function} [reviver] - Optional reviver function (will be composed with large int handling)
 * @returns {any} Parsed object with large integers as BigInt
 * @throws {SyntaxError} If the text is not valid JSON
 *
 * @example
 * const result = parseJSON('{"id": "12345678901234567890"}');
 * // result.id will be BigInt(12345678901234567890n)
 */
const parseJSON = (text, reviver) => {
  if (typeof text !== 'string') {
    throw new TypeError('First argument must be a string');
  }

  const largeIntReviver = (key, value) => {
    // Use utility function to check and convert large integers
    if (isLargeInteger(value)) {
      const bigIntValue = toBigIntSafe(value);
      // Only convert if toBigIntSafe actually returned a BigInt
      if (typeof bigIntValue === 'bigint') {
        return bigIntValue;
      }
    }

    // Handle unsafe numbers (beyond safe integer range)
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      // Convert to string to preserve precision
      return value.toString();
    }

    // Apply user reviver if provided
    return typeof reviver === 'function' ? reviver(key, value) : value;
  };

  return JSON.parse(text, largeIntReviver);
};

/**
 * Custom JSON.stringify that serializes BigInt and unsafe numbers as strings.
 * Preserves precision for large integers and handles BigInt serialization.
 *
 * @param {any} value - Value to stringify
 * @param {function|Array|null} [replacer] - Optional replacer function or array
 * @param {number|string} [space] - Optional spacing for formatting
 * @returns {string} JSON string with large integers preserved as strings
 *
 * @example
 * const data = { id: BigInt('12345678901234567890'), count: 42 };
 * const json = stringifyJSON(data);
 * // Result: '{"id":"12345678901234567890","count":42}'
 */
const stringifyJSON = (value, replacer, space) => {
  const safeReplacer = (key, val) => {
    // Handle BigInt values
    if (typeof val === 'bigint') {
      return val.toString();
    }

    // Handle string representations of large integers (preserve as-is)
    if (typeof val === 'string' && /^-?\d{16,}$/.test(val)) {
      return val;
    }

    // Handle unsafe numbers
    if (typeof val === 'number' && !Number.isSafeInteger(val)) {
      return val.toString();
    }

    // Apply user-provided replacer logic
    if (typeof replacer === 'function') {
      return replacer(key, val);
    }

    // Handle array replacer (whitelist of keys)
    if (Array.isArray(replacer)) {
      return replacer.includes(key) ? val : undefined;
    }

    return val;
  };

  return JSON.stringify(value, safeReplacer, space);
};

/**
 * Utility to check if a value represents a large integer
 * @param {any} value - Value to check
 * @returns {boolean} True if value is a large integer (BigInt or string representation)
 */
const isLargeInteger = value => {
  if (typeof value === 'bigint') return true;
  if (typeof value === 'string' && /^-?\d{16,}$/.test(value)) return true;
  return false;
};

/**
 * Safely convert a value to BigInt if it represents a large integer
 * @param {any} value - Value to convert
 * @returns {BigInt|any} BigInt if conversion possible, original value otherwise
 */
const toBigIntSafe = value => {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'string' && /^-?\d{16,}$/.test(value)) {
      return BigInt(value);
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      return BigInt(value);
    }
  } catch (error) {
    // Conversion failed, return original value
  }
  return value;
};

/**
 * Check if a filesystem entry exists at the given path and return its stat if exists.
 * @param {string} targetPath
 * @returns {Promise<false|fs.Stats>}
 */
async function getPathInfo(targetPath) {
  try {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      throw new TypeError('Invalid path');
    }

    const stat = await fs.promises.lstat(path.resolve(targetPath));
    return stat;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Recursively create a directory if it does not exist.
 * @param {string} directoryPath
 * @returns {Promise<boolean>}
 */
const createDirectory = async directoryPath => {
  if (typeof directoryPath !== 'string' || !directoryPath.trim()) {
    throw new TypeError('Invalid directory path');
  }
  try {
    await fs.promises.mkdir(path.resolve(directoryPath), { recursive: true });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return true;
    throw err;
  }
};

/**
 * Creates a JSON stream parser.
 *
 * Note: This parser expects the input JSON to be chunked into valid JSON objects or arrays.
 * For very large or deeply nested JSON, partial parsing may be incomplete.
 *
 * @param {string|Array} pattern - JSONPath pattern or array of keys (e.g. 'foo.bar.*')
 * @param {Function} [transformFn] - Function to transform matched data
 * @returns {Transform} Transform stream emitting matched objects
 */
const createStreamParser = (pattern = '*', transformFn) => {
  if (pattern !== '*' && !Array.isArray(pattern) && typeof pattern !== 'string') {
    throw new TypeError('Pattern must be a string, array, or "*"');
  }
  if (transformFn !== undefined && typeof transformFn !== 'function') {
    throw new TypeError('TransformFn must be a function if provided');
  }

  let isArrayStart, isArrayEnd;
  let jsonBuffer = '';
  let bracketDepth = 0;
  let insideString = false;
  let isEscaped = false;
  let isDestroyed = false;

  // Support patterns like 'users.*' to extract objects at a path
  let normalizedPattern = pattern;
  if (typeof pattern === 'string') {
    normalizedPattern = pattern.split('.').map(element => {
      if (element === '*') return '*';
      return element;
    });
  }
  const activePattern =
    Array.isArray(normalizedPattern) && normalizedPattern.length ? normalizedPattern : null;

  const createTransformStream = (write, end, opts = {}) =>
    new Transform({
      objectMode: true,
      transform(chunk, _encoding, callback) {
        try {
          write.call(this, chunk);
          callback();
        } catch (err) {
          callback(err);
        }
      },
      flush(callback) {
        try {
          if (typeof end === 'function') end.call(this);
          callback();
        } catch (err) {
          callback(err);
        }
      },
      ...opts,
    });

  // Recursively walk the object to match the pattern
  const processValue = jsonValue => {
    if (isDestroyed) return;
    if (!activePattern) {
      stream.push(jsonValue);
      return;
    }
    const walk = (obj, patternArr, idx) => {
      if (idx === patternArr.length) {
        // Matched full pattern
        stream.push(obj);
        return;
      }
      const pat = patternArr[idx];
      if (pat === '*') {
        if (Array.isArray(obj)) {
          for (const item of obj) walk(item, patternArr, idx + 1);
        } else if (typeof obj === 'object' && obj !== null) {
          for (const key in obj) walk(obj[key], patternArr, idx + 1);
        }
      } else if (typeof obj === 'object' && obj !== null && pat in obj) {
        walk(obj[pat], patternArr, idx + 1);
      }
    };
    walk(jsonValue, activePattern, 0);
  };

  const stream = createTransformStream(
    chunk => {
      if (isDestroyed) return;

      const chunkStr = chunk.toString();
      for (let i = 0; i < chunkStr.length; i++) {
        const char = chunkStr[i];

        if (isEscaped) {
          isEscaped = false;
          jsonBuffer += char;
          continue;
        }

        if (char === '\\' && insideString) {
          isEscaped = true;
          jsonBuffer += char;
          continue;
        }

        if (char === '"' && !isEscaped) {
          insideString = !insideString;
        }

        if (!insideString) {
          if (char === '{' || char === '[') {
            bracketDepth++;
          } else if (char === '}' || char === ']') {
            bracketDepth--;
          }
        }

        jsonBuffer += char;

        // Try to parse complete JSON objects
        if (bracketDepth === 0 && (char === '}' || char === ']')) {
          try {
            const value = parseJSON(jsonBuffer);
            processValue(value);
            jsonBuffer = '';
          } catch (err) {
            // Not a complete JSON object yet, continue buffering
            if (jsonBuffer.length > 1024 * 1024) {
              // 1MB buffer limit
              stream.destroy(new Error('Buffer size exceeded while parsing JSON'));
            }
          }
        }
      }
    },
    () => {
      if (isDestroyed) return;

      if (jsonBuffer.trim()) {
        try {
          const value = parseJSON(jsonBuffer);
          processValue(value);
        } catch (err) {
          stream.emit('error', new Error('Invalid JSON at end of stream'));
        }
      }
      if (isArrayStart) stream.emit('isArrayStart', isArrayStart);
      if (isArrayEnd) stream.emit('isArrayEnd', isArrayEnd);
      stream.push(null);
    }
  );

  // Add cleanup method
  const originalDestroy = stream.destroy;
  stream.destroy = function (error) {
    isDestroyed = true;
    jsonBuffer = '';
    originalDestroy.call(this, error);
  };

  return stream;
};

/**
 * Reads a JSON file and returns both parsed and raw data
 * Supports streaming for large files and pattern-based data extraction
 *
 * @param {string} filePath
 * @param {Object} options
 * @param {string|Array} [options.jsonPathPattern='*']
 * @param {boolean} [options.includeRawData=false]
 * @param {string} [options.encoding='utf8']
 * @param {number} [options.maxBufferSize=1048576]
 * @param {number} [options.maxFileSize=104857600]
 * @returns {Promise<{parsed: Array, raw: string, isFileAccessible: boolean, error: Error}>}
 *
 * @example
 * (async () => {
 *   const { parsed, raw, isFileAccessible, error } = await readJSONFile('./data.json', {
 *     jsonPathPattern: ['users', '*', 'id'], // Example pattern
 *     includeRawData: true,
 *     maxFileSize: 50 * 1024 * 1024, // 50MB max
 *   });
 *
 *   if (error) {
 *     console.error('Failed to read JSON:', error);
 *     return;
 *   }
 *
 *   console.log('Parsed data:', parsed);
 *   console.log('Raw data:', raw);
 *   console.log('File accessible:', isFileAccessible);
 * })();
 */
const readJSONFile = async (
  filePath,
  {
    jsonPathPattern = '*',
    includeRawData = false,
    encoding = 'utf8',
    maxBufferSize = 1024 * 1024,
    maxFileSize = 1024 * 1024 * 100,
  } = {}
) => {
  const result = { parsed: [], raw: '', isFileAccessible: false, error: null };

  // Validate inputs, but do NOT throw — instead set error and return immediately
  if (typeof filePath !== 'string' || !filePath.trim()) {
    result.error = new TypeError('filePath must be a non-empty string');
    return result;
  }
  if (typeof maxBufferSize !== 'number' || maxBufferSize <= 0) {
    result.error = new TypeError('maxBufferSize must be a positive number');
    return result;
  }
  if (typeof maxFileSize !== 'number' || maxFileSize <= 0) {
    result.error = new TypeError('maxFileSize must be a positive number');
    return result;
  }

  let totalBufferSize = 0;
  let readStream = null;
  let jsonStream = null;

  try {
    const stats = await getPathInfo(filePath);
    if (!stats) {
      result.error = new Error(`File not found: ${filePath}`);
      return result;
    }
    if (stats.size === 0) throw new Error('File is empty');
    if (stats.size > maxFileSize)
      throw new Error(
        `File too large (${(stats.size / 1024 / 1024).toFixed(2)}MB). Max allowed: ${(maxFileSize / 1024 / 1024).toFixed(2)}MB`
      );

    result.isFileAccessible = true;

    readStream = fs.createReadStream(filePath, { encoding });

    jsonStream = createStreamParser(jsonPathPattern);

    const rawDataChunks = [];
    if (includeRawData) {
      readStream.on('data', chunk => {
        totalBufferSize += chunk.length;
        if (totalBufferSize > maxBufferSize) {
          readStream.destroy(
            new Error(`Buffer size exceeded (${(totalBufferSize / 1024 / 1024).toFixed(2)}MB)`)
          );
        }
        rawDataChunks.push(chunk);
      });
    }

    readStream.on('error', err => {
      result.error = new Error(`Error reading file: ${err.message}`);
      readStream.destroy(err);
    });

    jsonStream.on('error', err => {
      result.error = new Error(`Error parsing JSON: ${err.message}`);
      readStream.destroy(err);
    });

    await pipelineAsync(
      readStream,
      jsonStream,
      new Transform({
        objectMode: true,
        transform(chunk, _, callback) {
          try {
            if (Array.isArray(chunk)) result.parsed.push(...chunk);
            else result.parsed.push(chunk);
            callback();
          } catch (error) {
            callback(error);
          }
        },
      })
    );

    if (includeRawData && rawDataChunks.length) {
      result.raw = rawDataChunks.join('');
    }
  } catch (error) {
    console.error(`Error reading JSON file at ${filePath}:`, error);
    result.error = result.error || error;
  } finally {
    cleanupStream(readStream);
    cleanupStream(jsonStream);
  }
  return result;
};

/**
 * Writes data to a JSON file with chunked writing and progress tracking.
 * Atomic write with file locking and directory creation.
 * Supports both arrays and objects as input data, with special handling for huge objects.
 *
 * @param {string} filePath
 * @param {Array<any>|Object} data - Array for chunked processing or Object for direct write
 * @param {Object} options
 * @param {number} [options.chunkSize=100] - Number of items per write chunk (arrays) or properties per chunk (objects)
 * @param {boolean} [options.pretty=false]
 * @param {function} [options.onProgress] - Progress callback
 * @param {number} [options.batchSize=1000] - Number of items to process per batch
 * @param {function} [options.replacer] - Optional replacer function for stringifying
 * @param {number} [options.objectChunkThreshold=1000] - Threshold for chunking object properties
 * @param {number} [options.maxStringifySize=50*1024*1024] - Max size for direct stringify (50MB)
 * @param {number} [options.maxListeners=30] - Max number of listeners for the write stream
 * @returns {Promise<{success: boolean, error?: Error}>}
 *
 * @example
 * // Array example
 * const arrayData = [{ id: 1 }, { id: 2 }, { id: 3 }];
 * const success = await writeJSONFile('./array-output.json', arrayData, {
 *   chunkSize: 2,
 *   pretty: true,
 *   onProgress: ({ processed, total, percentage }) => {
 *     console.log(`Progress: ${processed}/${total} (${percentage}%)`);
 *   },
 * });
 *
 * @example
 * // Small object example
 * const objectData = { users: [{ id: 1 }], config: { version: '1.0' } };
 * const success = await writeJSONFile('./object-output.json', objectData, {
 *   pretty: true
 * });
 *
 * @example
 * // Huge object example
 * const hugeObject = { // thousands of properties // };
 * const success = await writeJSONFile('./huge-object.json', hugeObject, {
 *   pretty: true,
 *   objectChunkThreshold: 500, // Chunk if more than 500 properties
 *   chunkSize: 50, // Process 50 properties at a time
 *   onProgress: ({ processed, total, percentage }) => {
 *     console.log(`Progress: ${processed}/${total} properties (${percentage}%)`);
 *   }
 * });
 */
const writeJSONFile = async (
  filePath,
  data,
  {
    chunkSize = 100,
    pretty = false,
    onProgress,
    batchSize = 1000,
    replacer,
    maxListeners = 30,
    objectChunkThreshold = 1000,
    maxStringifySize = 50 * 1024 * 1024, // 50MB
  } = {}
) => {
  // Validate inputs, but do NOT throw — instead set error and return immediately
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return { success: false, error: new TypeError('Invalid file path') };
  }

  // Validate data type
  if (data === null || data === undefined) {
    return { success: false, error: new TypeError('Data cannot be null or undefined') };
  }

  const isArray = Array.isArray(data);
  const isObject = typeof data === 'object' && !isArray;

  if (!isArray && !isObject) {
    return { success: false, error: new TypeError('Data must be an array or object') };
  }

  // Validate options
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    return { success: false, error: new RangeError('chunkSize must be a positive integer') };
  }

  if (isArray && (!Number.isInteger(batchSize) || batchSize < 1)) {
    return { success: false, error: new RangeError('batchSize must be a positive integer') };
  }

  if (!Number.isInteger(objectChunkThreshold) || objectChunkThreshold < 1) {
    return {
      success: false,
      error: new RangeError('objectChunkThreshold must be a positive integer'),
    };
  }

  if (!Number.isInteger(maxListeners) || maxListeners < 1) {
    return { success: false, error: new RangeError('maxListeners must be a positive integer') };
  }

  const lockHandler = withMutex(filePath);
  await lockHandler.lock();

  const tempFilePath = filePath + '.tmp';
  let writeStream = null;
  let writeError = null;

  try {
    await createDirectory(path.dirname(filePath));

    writeStream = fs.createWriteStream(tempFilePath, { encoding: 'utf8' });
    writeStream.setMaxListeners(maxListeners);

    // Capture write errors asynchronously
    const writeErrorPromise = new Promise((_, reject) => {
      writeStream.on('error', error => {
        writeError = error;
        reject(new Error(`Error writing to file ${tempFilePath}: ${error.message}`));
      });
    });

    // Handle object data
    if (isObject) {
      // Large object - use chunked processing
      await writeChunkedObject(writeStream, data, {
        chunkSize,
        pretty,
        onProgress,
        replacer,
        writeErrorPromise,
      });
    } else {
      // Handle array data with chunking (original logic)
      await writeChunkedArray(writeStream, data, {
        chunkSize,
        batchSize,
        pretty,
        onProgress,
        replacer,
        writeErrorPromise,
      });
    }

    writeStream.end();

    await Promise.race([
      new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      }),
      writeErrorPromise,
    ]);

    if (writeError) throw writeError;

    // Attempt atomic rename
    const renameResult = await safeRenameTempFile(tempFilePath, filePath);
    if (!renameResult.success) return renameResult;

    return { success: true };
  } catch (error) {
    return { success: false, error };
  } finally {
    lockHandler.unlock();
    cleanupStream(writeStream);
    await safeCleanupTempFile(tempFilePath);
  }
};

/**
 * Writes a chunked object to the stream
 * @private
 */
async function writeChunkedObject(
  writeStream,
  data,
  { chunkSize, pretty, onProgress, replacer, writeErrorPromise }
) {
  const indent = pretty ? '  ' : '';
  const newline = pretty ? '\n' : '';
  const space = pretty ? ' ' : '';

  writeStream.write(`{${newline}`);

  let processed = 0;
  let isFirstProperty = true;
  let currentChunk = [];

  // Use for...in loop to avoid creating Object.keys() array
  for (const key in data) {
    if (!data.hasOwnProperty(key)) continue;

    currentChunk.push(key);

    // Process chunk when it reaches the desired size
    if (currentChunk.length >= chunkSize) {
      await processObjectChunk(writeStream, data, currentChunk, {
        isFirstProperty,
        pretty,
        replacer,
        writeErrorPromise,
        indent,
        newline,
        space,
      });

      processed += currentChunk.length;
      isFirstProperty = false;
      currentChunk = [];

      // Progress callback
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            processed,
            total: null, // Unknown total for streaming
            percentage: null, // Cannot calculate percentage without total
          });
        } catch {
          // Ignore progress callback errors
        }
      }

      // Allow event loop to breathe
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  // Process remaining properties in the last chunk
  if (currentChunk.length > 0) {
    await processObjectChunk(writeStream, data, currentChunk, {
      isFirstProperty,
      pretty,
      replacer,
      writeErrorPromise,
      indent,
      newline,
      space,
      isLastChunk: true,
    });

    processed += currentChunk.length;

    if (typeof onProgress === 'function') {
      try {
        onProgress({
          processed,
          total: processed, // Final total
          percentage: 100,
        });
      } catch {
        // Ignore progress callback errors
      }
    }
  }

  writeStream.write(`${newline}}`);
}

/**
 * Processes a chunk of object properties
 * @private
 */
async function processObjectChunk(
  writeStream,
  data,
  keyChunk,
  { isFirstProperty, pretty, replacer, writeErrorPromise, indent, newline, space }
) {
  const properties = keyChunk.map((key, index) => {
    const isFirstInChunk = index === 0 && isFirstProperty;

    const keyStr = stringifyJSON(key, replacer);
    const valueStr = stringifyJSON(data[key], replacer, pretty ? 2 : 0);

    let property;
    if (pretty) {
      const indentedValue = valueStr
        .split('\n')
        .map((line, lineIndex) => (lineIndex === 0 ? line : indent + line))
        .join('\n');
      property = `${indent}${keyStr}:${space}${indentedValue}`;
    } else {
      property = `${keyStr}:${valueStr}`;
    }

    // Add comma prefix for all properties except the first one
    if (!isFirstInChunk) {
      property = ',' + (pretty ? newline : '') + property;
    }

    return property;
  });

  const chunkData = properties.join('');

  if (!writeStream.write(chunkData)) {
    await Promise.race([
      new Promise((resolve, reject) => {
        writeStream.once('drain', resolve);
        writeStream.once('error', reject);
      }),
      writeErrorPromise,
    ]);
  }
}

/**
 * Writes a chunked array to the stream
 * @private
 */
async function writeChunkedArray(
  writeStream,
  data,
  { chunkSize, batchSize, pretty, onProgress, replacer, writeErrorPromise }
) {
  writeStream.write(pretty ? '[\n' : '[');

  let processed = 0;
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);

    for (let j = 0; j < batch.length; j += chunkSize) {
      const chunk = batch.slice(j, j + chunkSize);
      const isLastChunk = i + j + chunk.length >= data.length;

      const jsonChunk = chunk
        .map(item => stringifyJSON(item, replacer, pretty ? 2 : 0))
        .join(pretty ? ',\n' : ',');

      const writeData = isLastChunk ? jsonChunk : jsonChunk + ',';

      if (!writeStream.write(writeData)) {
        await Promise.race([
          new Promise((resolve, reject) => {
            writeStream.once('drain', resolve);
            writeStream.once('error', reject);
          }),
          writeErrorPromise,
        ]);
      }
      processed += chunk.length;
    }

    if (typeof onProgress === 'function') {
      try {
        onProgress({
          processed: Math.min(processed, data.length),
          total: data.length,
          percentage: Math.round((Math.min(processed, data.length) / data.length) * 100),
        });
      } catch {
        // Ignore progress callback errors
      }
    }

    // Allow event loop to breathe
    if (i % (batchSize * 5) === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  writeStream.write(pretty ? '\n]' : ']');
}

/**
 * Atomically rename a temp file to the target file, cleaning up on failure.
 * @param {string} tempFilePath
 * @param {string} filePath
 * @returns {Promise<{success: boolean, error?: Error}>}
 */
const safeRenameTempFile = async (tempFilePath, filePath) => {
  try {
    await fs.promises.rename(tempFilePath, filePath);
    return { success: true };
  } catch (renameErr) {
    try {
      await fs.promises.unlink(tempFilePath);
    } catch (unlinkErr) {
      console.error('Failed to rename and failed to unlink temp file:', renameErr, unlinkErr);
      return {
        success: false,
        error: new Error(
          `Failed to rename temp file: ${renameErr.message}; and failed to unlink: ${unlinkErr.message}`
        ),
      };
    }
    console.error('Failed to rename temp file:', renameErr);
    return {
      success: false,
      error: new Error(`Failed to rename temp file: ${renameErr.message}`),
    };
  }
};

/**
 * Remove a temp file if it exists, logging errors but not throwing.
 * @param {string} tempFilePath
 */
async function safeCleanupTempFile(tempFilePath) {
  try {
    const stat = await getPathInfo(tempFilePath);
    if (stat) {
      if (stat.isDirectory()) {
        await fs.promises.rm(tempFilePath, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(tempFilePath);
      }
    }
  } catch (cleanupErr) {
    console.error('Cleanup: failed to unlink/rmdir temp file:', cleanupErr);
  }
}

module.exports = {
  readJSONFile,
  writeJSONFile,
  parseJSON,
  stringifyJSON,
};
