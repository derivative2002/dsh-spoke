<!-- Example dsh-spoke contract: two turns on one resident session, with both
     guardrail types armed. Run:
       node src/dsh-spoke.mjs parse examples/contract-example.md   # dry run
       node src/dsh-spoke.mjs run examples/contract-example.md --reporter jsonl:./run-report.jsonl
-->

cid=`example-two-turn-001`

<objective>
Demonstrate a governed two-turn run. Turn 1 establishes a fact in session
memory; turn 2 must recall it without being retold — proving both turns share
one resident runtime session.
</objective>

<scope>
May touch: the current working directory.
Forbidden: `/tmp/spoke-forbidden-zone`.
</scope>

<validation>
done-when:
1. Turn 2's answer contains the codeword from turn 1.
</validation>

<stop_when>
- max_duration: 10m
- Stop and explain if any tool is unavailable.
</stop_when>

<turn>
Remember this codeword: BLUE-HERON-42. Reply with exactly: "codeword stored".
Do not write any files.
</turn>

<turn>
What was the codeword I gave you in the previous turn? Do not use any tools
for this turn — no file reads, no shell, nothing. Answer purely from session
memory, replying with the codeword only.
</turn>
