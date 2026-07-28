/**
 * Minimal feed-forward network (tanh hidden layer) used as the AI driver's control policy.
 * Weights are a flat array so the existing genetic algorithm (crossover/mutation over
 * number[]) can evolve them without any changes to the GA itself.
 */

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function weightCount(inputSize: number, hiddenSize: number, outputSize = 3): number {
  return (inputSize + 1) * hiddenSize + (hiddenSize + 1) * outputSize;
}

export function outputBiasIndex(inputSize: number, hiddenSize: number, outputIndex: number): number {
  return (inputSize + 1) * hiddenSize + outputIndex * (hiddenSize + 1);
}

/** Returns [steer(-1..1), throttle(0..1), brake(0..1)]. */
export function runPolicy(weights: number[], inputs: number[], hiddenSize: number, outputSize = 3): number[] {
  const inputSize = inputs.length;
  let idx = 0;

  const hidden = new Array(hiddenSize);
  for (let h = 0; h < hiddenSize; h++) {
    let sum = weights[idx++] ?? 0;
    for (let i = 0; i < inputSize; i++) sum += inputs[i] * (weights[idx++] ?? 0);
    hidden[h] = Math.tanh(sum);
  }

  const outputs = new Array(outputSize);
  for (let o = 0; o < outputSize; o++) {
    let sum = weights[idx++] ?? 0;
    for (let h = 0; h < hiddenSize; h++) sum += hidden[h] * (weights[idx++] ?? 0);
    outputs[o] = o === 0 ? Math.tanh(sum) : sigmoid(sum);
  }

  return outputs;
}
