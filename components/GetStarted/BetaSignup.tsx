import {event} from 'nextjs-google-analytics';
import {useRef, useState} from 'react';
import styles from './BetaSignup.module.css';

export default function BetaSignup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [buttonText, setButtonText] = useState('Join Waitlist');
  const form = useRef<HTMLFormElement>(null);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();

    setButtonText('Submitting...');

    const data = form.current;
    if (data === null) return;
    const formData = new FormData(data);
    const endpoint =
      'https://script.google.com/macros/s/AKfycbwMWYTH1CpaDIOdoQ4JTDgnq-fIucse6fm0ydVwBg2UBNvz8qToce16GrTsmT_q9PXdZw/exec';
    const options = {
      method: 'POST',
      body: formData,
    };

    const response = await fetch(endpoint, options);
    // check if response is 200 else display an error
    if (response.ok) {
      // display success message
      console.log('Beta request successfully sent.');
      setButtonText('Received');
      setName('');
      setEmail('');
      setMessage('');
      setTimeout(() => {
        setButtonText('Join Waitlist');
      }, 3000);
      event('beta_request_submitted', {
        category: 'Get started',
        action: 'Press join waitlist button',
        label: 'Conversion',
      });
    } else {
      // display error message
      console.log('error');
      setButtonText('Try Again');
    }
  };

  return (
    <div className={styles.formContainer}>
      <form ref={form} onSubmit={handleSubmit}>
        <div className={styles.inputContainer}>
          <label className={styles.formLabel} htmlFor="name">
            Full name
          </label>
          <input
            className={styles.textField}
            value={name}
            onChange={e => setName(e.target.value)}
            type="text"
            id="name"
            name="name"
            placeholder=""
          />
        </div>
        <div className={styles.inputContainer}>
          <label className={styles.formLabel} htmlFor="email">
            Email
          </label>
          <input
            className={styles.textField}
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            id="email"
            name="email"
            placeholder=""
          />
        </div>
        <div className={styles.inputContainer}>
          <label className={styles.formLabel} htmlFor="message">
            Message <span className={styles.optional}>optional</span>
          </label>
          <textarea
            className={styles.textArea}
            value={message}
            onChange={e => setMessage(e.target.value)}
            id="message"
            name="message"
            placeholder=""
          />
        </div>
        <div className={styles.ctaWrap}>
          <button className={styles.buttonPrimary} type="submit">
            {buttonText}
          </button>
        </div>
      </form>
    </div>
  );
}
