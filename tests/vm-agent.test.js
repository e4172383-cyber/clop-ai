import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVmRequest, runVmAgent, vmSafeDelta } from '../src/vm-agent.js';

const usage = (input, output) => ({ input, output, total: input + output, billable: input + output });

test('parses one valid VM request and rejects malformed or multiple requests', () => {
  assert.deepEqual(parseVmRequest('<clop_vm_request>{"command":"node -v"}</clop_vm_request>'), { command: 'node -v' });
  assert.equal(parseVmRequest('<clop_vm_request>{bad}</clop_vm_request>'), null);
  assert.equal(parseVmRequest('<clop_vm_request>{"command":"a"}</clop_vm_request><clop_vm_request>{"command":"b"}</clop_vm_request>'), null);
});

test('hides VM protocol from streaming but forwards an ordinary answer', () => {
  const seen = [];
  const toolDelta = vmSafeDelta((value) => seen.push(value));
  toolDelta('<clop_');
  toolDelta('<clop_vm_request>{"command":"date"}</clop_vm_request>');
  assert.deepEqual(seen, []);

  const answerDelta = vmSafeDelta((value) => seen.push(value));
  answerDelta('Г');
  answerDelta('Готово');
  assert.deepEqual(seen, ['Г', 'Готово']);
});

test('returns an ordinary answer without starting the VM', async () => {
  let executions = 0;
  let streamed = '';
  const result = await runVmAgent({
    prompt: 'Объясни цикл for',
    invokeModel: async () => ({ ok: true, text: 'Готовый ответ', tokens: usage(5, 3), durationMs: 10 }),
    executeCommand: async () => { executions += 1; return { ok: true, output: '' }; },
    onDelta: (text) => { streamed = text; },
  });
  assert.equal(result.text, 'Готовый ответ');
  assert.equal(result.vm.used, false);
  assert.equal(executions, 0);
  assert.equal(streamed, 'Готовый ответ');
});

test('executes a requested command, feeds back real output and totals model usage', async () => {
  const prompts = [];
  const commands = [];
  let cleaned = 0;
  const result = await runVmAgent({
    prompt: 'Проверь результат выражения',
    invokeModel: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? { ok: true, text: '<clop_vm_request>{"command":"printf 42"}</clop_vm_request>', tokens: usage(10, 4), durationMs: 20 }
        : { ok: true, text: 'Проверено: результат 42.', tokens: usage(7, 5), durationMs: 30, threadId: 'thread-1' };
    },
    executeCommand: async (command) => { commands.push(command); return { ok: true, output: '42', exitCode: 0 }; },
    cleanup: async () => { cleaned += 1; },
  });
  assert.deepEqual(commands, ['printf 42']);
  assert.match(prompts[1], /"output":"42"/);
  assert.equal(result.text, 'Проверено: результат 42.');
  assert.equal(result.tokens.total, 26);
  assert.equal(result.durationMs, 50);
  assert.equal(result.vm.used, true);
  assert.equal(cleaned, 1);
});
