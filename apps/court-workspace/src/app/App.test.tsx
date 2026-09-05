import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('Court Workspace shell', () => {
  it('renders the DCIECMS Court Workspace heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /DCIECMS Court Workspace/i })).toBeInTheDocument();
  });
});
