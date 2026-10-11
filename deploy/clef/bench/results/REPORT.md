# Inbox categories: Clef benchmark

How accurately Clef sorts the Inbox into categories, how fast, and what it costs. Every model was sent the requests the Worker itself sends: [`requests.mts`](../requests.mts) builds them from [`mail.jsonl`](../mail.jsonl) with the Worker's own code.

The messages are synthetic: written by an AI model to resemble a typical personal inbox, each with the category it belongs in. None of them is real mail. Names, email addresses and an IP address in them were replaced with placeholders after the runs, so a few messages are now slightly longer than when they were measured.

180 messages: Primary 45, Transactions 45, Updates 45, Promotions 45; with the user's own categories, School 18 and Travel 18 of them move there.

## Accuracy

| | Four built-in categories | lenient | + School, Travel | lenient | School: found / wrongly put there | Travel: found / wrongly |
|---|---|---|---|---|---|---|
| Quick guess (headers + subject, at ingest) | 76.1% | 80.0% | n/a | | | |
| clef-flash-bf16 | 92.8% | 97.2% | 95.6% | 98.3% | 18/18 / 0 | 17/18 / 0 |
| clef-flash-nf4 | 90.6% | 96.7% | 94.4% | 98.3% | 18/18 / 0 | 17/18 / 0 |
| clef-nf4 | 96.1% | 98.3% | 96.7% | 98.9% | 17/18 / 0 | 17/18 / 0 |
| workers-ai-clef-flash | 92.2% | 97.2% | 95.6% | 98.3% | 18/18 / 0 | 17/18 / 0 |

Lenient also counts the second label a line allows where the mail is genuinely ambiguous.

### clef-flash-bf16: where the built-in answers went

| gold \ answer | Primary | Transactions | Updates | Promotions | recall |
|---|---|---|---|---|---|
| Primary | **35** | 7 | 3 | · | 77.8% |
| Transactions | · | **45** | · | · | 100.0% |
| Updates | · | 1 | **44** | · | 97.8% |
| Promotions | · | 1 | 1 | **43** | 95.6% |
| precision | 100.0% | 83.3% | 91.7% | 100.0% | |

| top probability ≥ | answers kept | right among kept |
|---|---|---|
| 0.0 | 100.0% | 97.2% |
| 0.5 | 98.3% | 97.7% |
| 0.7 | 88.9% | 98.8% |
| 0.9 | 66.1% | 100.0% |

### clef-flash-nf4: where the built-in answers went

| gold \ answer | Primary | Transactions | Updates | Promotions | recall |
|---|---|---|---|---|---|
| Primary | **31** | 9 | 5 | · | 68.9% |
| Transactions | · | **45** | · | · | 100.0% |
| Updates | · | 1 | **44** | · | 97.8% |
| Promotions | · | 1 | 1 | **43** | 95.6% |
| precision | 100.0% | 80.4% | 88.0% | 100.0% | |

| top probability ≥ | answers kept | right among kept |
|---|---|---|
| 0.0 | 100.0% | 96.7% |
| 0.5 | 97.8% | 97.7% |
| 0.7 | 88.3% | 99.4% |
| 0.9 | 65.6% | 100.0% |

### clef-nf4: where the built-in answers went

| gold \ answer | Primary | Transactions | Updates | Promotions | recall |
|---|---|---|---|---|---|
| Primary | **38** | 4 | 3 | · | 84.4% |
| Transactions | · | **45** | · | · | 100.0% |
| Updates | · | · | **45** | · | 100.0% |
| Promotions | · | · | · | **45** | 100.0% |
| precision | 100.0% | 91.8% | 93.8% | 100.0% | |

| top probability ≥ | answers kept | right among kept |
|---|---|---|
| 0.0 | 100.0% | 98.3% |
| 0.5 | 98.3% | 98.9% |
| 0.7 | 91.7% | 99.4% |
| 0.9 | 82.8% | 100.0% |

### workers-ai-clef-flash: where the built-in answers went

| gold \ answer | Primary | Transactions | Updates | Promotions | recall |
|---|---|---|---|---|---|
| Primary | **34** | 7 | 4 | · | 75.6% |
| Transactions | · | **45** | · | · | 100.0% |
| Updates | · | 1 | **44** | · | 97.8% |
| Promotions | · | 1 | 1 | **43** | 95.6% |
| precision | 100.0% | 83.3% | 89.8% | 100.0% | |

| top probability ≥ | answers kept | right among kept |
|---|---|---|
| 0.0 | 100.0% | 97.2% |
| 0.5 | 97.2% | 97.7% |
| 0.7 | 88.9% | 98.8% |
| 0.9 | 66.7% | 100.0% |

### The quick guess

| gold \ answer | Primary | Transactions | Updates | Promotions | recall |
|---|---|---|---|---|---|
| Primary | **33** | 3 | 9 | · | 73.3% |
| Transactions | 5 | **32** | 8 | · | 71.1% |
| Updates | · | 3 | **42** | · | 93.3% |
| Promotions | 1 | · | 14 | **30** | 66.7% |
| precision | 84.6% | 84.2% | 57.5% | 100.0% | |

clef-flash-bf16 and clef-flash-nf4 give the same built-in answer for 176 of 180 messages.
clef-flash-bf16 and clef-nf4 give the same built-in answer for 172 of 180 messages.
clef-flash-bf16 and workers-ai-clef-flash give the same built-in answer for 179 of 180 messages.
clef-flash-nf4 and clef-nf4 give the same built-in answer for 168 of 180 messages.
clef-flash-nf4 and workers-ai-clef-flash give the same built-in answer for 177 of 180 messages.
clef-nf4 and workers-ai-clef-flash give the same built-in answer for 171 of 180 messages.

### clef-flash-bf16: wrong built-in answers (5)

| id | gold | answer | top probability |
|---|---|---|---|
| a031 | Updates | Transactions | 0.46 |
| a049 | Primary | Transactions | 0.74 |
| c017 | Primary | Transactions | 0.58 |
| c037 | Primary | Transactions | 0.65 |
| c045 | Primary | Updates | 0.77 |

### clef-flash-nf4: wrong built-in answers (6)

| id | gold | answer | top probability |
|---|---|---|---|
| a001 | Primary | Updates | 0.54 |
| a031 | Updates | Transactions | 0.49 |
| a049 | Primary | Transactions | 0.67 |
| c017 | Primary | Transactions | 0.48 |
| c037 | Primary | Transactions | 0.61 |
| c045 | Primary | Updates | 0.86 |

### clef-nf4: wrong built-in answers (3)

| id | gold | answer | top probability |
|---|---|---|---|
| a049 | Primary | Transactions | 0.75 |
| c017 | Primary | Updates | 0.55 |
| c037 | Primary | Updates | 0.38 |

### workers-ai-clef-flash: wrong built-in answers (5)

| id | gold | answer | top probability |
|---|---|---|---|
| a031 | Updates | Transactions | 0.46 |
| a049 | Primary | Transactions | 0.74 |
| c017 | Primary | Transactions | 0.58 |
| c037 | Primary | Transactions | 0.64 |
| c045 | Primary | Updates | 0.77 |

## On this machine

| | GPU memory, loaded / peak | per message, median / p95 | messages a minute | package power, idle / running | energy per message |
|---|---|---|---|---|---|
| clef-flash-bf16 | 18.0 / 18.63 GiB | 0.71 / 0.83 s | 82 | 17.4 / 108.2 W | 79 J (66 J above idle) |
| clef-flash-nf4 | 8.69 / 9.53 GiB | 1.02 / 1.16 s | 57 | 21.7 / 100.2 W | 106 J (83 J above idle) |
| clef-nf4 | 19.08 / 20.06 GiB | 2.94 / 3.44 s | 19 | 19.4 / 110.8 W | 342 J (282 J above idle) |

## On Workers AI

| | per message in the Worker, median / p95 | round trip from here, median | wall time, all requests |
|---|---|---|---|
| workers-ai-clef-flash | 0.27 / 0.51 s | 0.28 s | 27.2 s for 360, 4 at a time |

workers-ai-clef-flash against clef-flash bf16 here: billed tokens equal the local count for 360 of 360 requests; the same answer for 359; no probability differs by more than 0.013.

## Tokens per message, and what Workers AI would charge

Workers AI bills input tokens only, and nothing for output: clef-flash $0.09 per million, its 10,000 free neurons a day being 1.22 M tokens; clef $0.24 per million, its 10,000 free neurons a day being 0.46 M tokens. Both models count the same tokens.

| request | fixed part | per message: mean | median | p95 | max | $ per 1,000 messages (mean): Clef-Flash | Clef |
|---|---|---|---|---|---|---|---|
| four built-in categories | 315 | 649 | 669 | 787 | 802 | $0.0584 | $0.1558 |
| + two of the user's own | 414 | 748 | 768 | 886 | 901 | $0.0673 | $0.1795 |

17 of 180 messages are longer than the 1,500 characters a request carries, so the longest requests are close to the most any message can cost.

A mailbox, with two own categories: at this set's mean of 748 tokens a message, and, more cautiously, with every message as long as the cut lets one be (849 tokens, the mean of those that reach it).

### clef-flash

| mail a day | tokens a month | $ a month | the 180-day window (the first sweep, or after a category change) | $ for it | the free daily allowance used |
|---|---|---|---|---|---|
| 20 | 0.45 M – 0.51 M | $0.0404 – $0.0458 | 2.69 M – 3.06 M | $0.2424 – $0.2751 | 1.2% – 1.4% |
| 50 | 1.12 M – 1.27 M | $0.1010 – $0.1146 | 6.73 M – 7.64 M | $0.6059 – $0.6877 | 3.1% – 3.5% |
| 150 | 3.37 M – 3.82 M | $0.3029 – $0.3438 | 20.20 M – 22.92 M | $1.82 – $2.06 | 9.2% – 10.4% |
| 500 | 11.22 M – 12.73 M | $1.01 – $1.15 | 67.32 M – 76.41 M | $6.06 – $6.88 | 30.6% – 34.7% |

### clef

| mail a day | tokens a month | $ a month | the 180-day window (the first sweep, or after a category change) | $ for it | the free daily allowance used |
|---|---|---|---|---|---|
| 20 | 0.45 M – 0.51 M | $0.1077 – $0.1223 | 2.69 M – 3.06 M | $0.6463 – $0.7335 | 3.3% – 3.7% |
| 50 | 1.12 M – 1.27 M | $0.2693 – $0.3056 | 6.73 M – 7.64 M | $1.62 – $1.83 | 8.2% – 9.3% |
| 150 | 3.37 M – 3.82 M | $0.8078 – $0.9169 | 20.20 M – 22.92 M | $4.85 – $5.50 | 24.5% – 27.8% |
| 500 | 11.22 M – 12.73 M | $2.69 – $3.06 | 67.32 M – 76.41 M | $16.16 – $18.34 | 81.6% – 92.6% |

