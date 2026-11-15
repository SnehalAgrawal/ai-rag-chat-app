import React, { useState } from 'react';
import FileUpload from '../components/FileUpload';
import ChatWindow from '../components/ChatWindow';

export default function Home() {
  const [uploaded, setUploaded] = useState(false);

  const handleUploadSuccess = () => {
    setUploaded(true);
  };

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', padding: '2rem', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
      <h1>RAG AI Chat</h1>
      {!uploaded ? (
        <FileUpload onUploadSuccess={handleUploadSuccess} />
      ) : (
        <ChatWindow />
      )}
    </div>
  );
}