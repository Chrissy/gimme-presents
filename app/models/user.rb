class User < ActiveRecord::Base
  devise :omniauthable, :omniauth_providers => [:google_oauth2]

  def authenticated?
    email.present? && password.present?
  end

  def add_omniauth_data(data)

    return self if authenticated?

    update_attributes(name: data["name"],
      email: data["email"],
      image: data["image"],
      password: Devise.friendly_token[0,20]
    )

    self
  end

  def self.merge_users(user_1, user_2)
    List.where(:user => user_1.id).each do |list|
      list.update_attribute(:user, user_2.id)
    end
    user_1.delete
    user_2
  end

  def self.find_or_merge_with_omniauth(access_token, session_user)
    data = access_token.info
    lookup_attempt = User.where(:email => data["email"]).first

    if session_user == lookup_attempt
      session_user
    elsif lookup_attempt && session_user
      merge_users(session_user, lookup_attempt)
    elsif lookup_attempt
      lookup_attempt
    elsif session_user
      session_user.add_omniauth_data(data)
    else
      nil
    end
  end

end
