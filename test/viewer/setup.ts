import { configure } from '@testing-library/react';

// A loaded CI runner (Windows especially) can take over a second for a file's first render of the shell, past
// testing-library's 1 s default for findBy* and waitFor. Passing tests return as soon as their condition holds;
// this stays under vitest's 5 s test timeout so a real failure still reports the unmet condition.
configure({ asyncUtilTimeout: 3000 });
