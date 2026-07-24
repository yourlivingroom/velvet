import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';   // base theme (in @layer velvet-base; operator /theme.css overrides)
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
