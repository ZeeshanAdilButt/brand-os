# Publishing package: sample-post

**Primary title:** How Queues Hide Latency, Starting From One Counter

**Alternate titles**
- Queues Are Where Latency Lives
- The Counter That Explains Your Tail
- Little's Law For People Who Run Pagers

**URL slug:** /blog/sample-post

**Meta title:** How Queues Hide Latency: A Counter-First View

**Meta description:** Latency lives in queues, not in service time. A short tour of one counter, three graphs and the arithmetic that ties them together.

**Excerpt (index/home):** Latency lives in queues. Once you can read one counter, the three graphs on your dashboard turn into a single piece of arithmetic.

**OG / social card text:** Service time is 4 ms. Queue time is the rest. Measure the queue.

**Social visual concept:** A single pipe with a queue of boxes in front of it.

**Search intent:** An engineer with a slow endpoint wants to know where the time goes.

**Key entities / terms:** latency, queue, Little's Law, utilisation, p99, saturation.

**Suggested internal links:** The capacity planning playbook.

**Further-reading path:** utilisation, then saturation, then tail latency.

**Reviewer mood:** this label is not part of the set and must be ignored.

## Fact labels used

- Documented: Little's Law relates mean queue length, arrival rate and wait time.
- Measured on the fleet: 31 series to 7 after aggregation.
- Illustrative: 50 requests per worker. The article says so.

## Verify before publishing

- Confirm the Little's Law statement against the cited paper.
- Re-check the p99 figure against the current dashboard.
