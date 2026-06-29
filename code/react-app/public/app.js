const e = React.createElement;

function App() {
  return e('div', { style: { fontFamily: 'Arial, sans-serif', padding: '2rem' } }, [
    e('h1', null, 'React App'),
    e('p', null, 'This app responds to /health for liveness and readiness probes.'),
    e('p', null, 'Endpoint: /health returns ok')
  ]);
}

ReactDOM.createRoot(document.getElementById('root')).render(e(App));
